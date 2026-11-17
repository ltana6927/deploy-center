"""Verify portable image identity without equating config and manifest digests."""

import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile
import zipfile

DIGEST = r"sha256:[a-f0-9]{64}"


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def image_identity(path, image_ref, revision, registry_digest):
    with tarfile.open(path, "r:*") as archive:
        members = {}
        total = 0
        for member in archive:
            total += member.size
            if (len(members) >= 10000 or member.size < 0 or total > 4 * 2 ** 30 or member.name in members or
                    member.name.startswith("/") or ".." in pathlib.PurePosixPath(member.name).parts):
                raise ValueError("Image tar exceeds limits or repeats a member")
            members[member.name] = member

        def read(name):
            member = members.get(name)
            if (not member or not member.isfile() or member.size > 1024 * 1024 or
                    name.startswith("/") or ".." in pathlib.PurePosixPath(name).parts):
                raise ValueError("Invalid image metadata member")
            return archive.extractfile(member).read()

        def blob(digest):
            if not re.fullmatch(DIGEST, digest):
                raise ValueError("Invalid OCI digest")
            raw = read("blobs/sha256/" + digest[7:])
            if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
                raise ValueError("OCI blob digest mismatch")
            return json.loads(raw)

        manifest = json.loads(read("manifest.json"))
        if len(manifest) != 1 or manifest[0].get("RepoTags") != [image_ref]:
            raise ValueError("Archive must contain only the requested image tag")
        entry = manifest[0]
        config_name = entry.get("Config", "")
        if not re.fullmatch(r"(?:blobs/sha256/[a-f0-9]{64}|[a-f0-9]{64}\.json)", config_name):
            raise ValueError("Invalid image config path")
        raw_config = read(config_name)
        config_id = "sha256:" + hashlib.sha256(raw_config).hexdigest()
        if pathlib.PurePosixPath(config_name).name.split(".", 1)[0] != config_id[7:]:
            raise ValueError("Image config digest mismatch")
        config = json.loads(raw_config)
        if config.get("os") != "linux" or config.get("architecture") != "amd64":
            raise ValueError("Archive image must target linux/amd64")
        if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != revision:
            raise ValueError("Archive config revision mismatch")
        layers = entry.get("Layers", [])
        diff_ids = config.get("rootfs", {}).get("diff_ids", [])
        if len(layers) != len(diff_ids) or any(not re.fullmatch(DIGEST, value) for value in diff_ids):
            raise ValueError("Archive layers do not match the image config")
        for layer in layers:
            member = members.get(layer)
            if not member or not member.isfile():
                raise ValueError("Image archive is missing a layer")

        # Legacy containerd receipts can record an index/manifest ID. Accept it
        # only when the archive's hashed OCI descriptor chain reaches this exact
        # platform config. Classic Docker receipts already contain config_id.
        identifiers = {config_id}
        resolved = {}
        visiting = set()

        def visit(digest, depth=0):
            if depth > 4 or digest in visiting or len(resolved) + len(visiting) >= 256:
                raise ValueError("OCI descriptor graph exceeds limits or contains a cycle")
            if digest in resolved:
                return resolved[digest]
            visiting.add(digest)
            document = blob(digest)
            if document.get("config", {}).get("digest") == config_id:
                identifiers.add(digest)
                visiting.remove(digest)
                resolved[digest] = True
                return True
            descriptors = document.get("manifests", [])
            if len(descriptors) > 128:
                raise ValueError("Too many OCI manifests")
            matched = False
            for descriptor in descriptors:
                platform = descriptor.get("platform", {})
                if platform and (platform.get("os"), platform.get("architecture")) != ("linux", "amd64"):
                    continue
                if visit(descriptor.get("digest", ""), depth + 1):
                    matched = True
            if matched:
                identifiers.add(digest)
            visiting.remove(digest)
            resolved[digest] = matched
            return matched

        if "blobs/sha256/" + registry_digest[7:] in members:
            if not visit(registry_digest):
                raise ValueError("Registry descriptor does not identify the exported config")
        return {"config_id": config_id, "identifiers": sorted(identifiers), "revision": revision}


def verify_archive(directory, artifact_digest, image_ref, revision):
    (directory / "verified-image.json").unlink(missing_ok=True)
    if "sha256:" + checksum(directory / "image.zip") != artifact_digest:
        raise ValueError("Build artifact checksum mismatch")
    allowed = {"main-image.tar.gz": 2 ** 30, "main-image.tar.gz.sha256": 128, "image.json": 4096}
    with zipfile.ZipFile(directory / "image.zip") as archive:
        entries = archive.infolist()
        if len(entries) != len(allowed) or {entry.filename for entry in entries} != set(allowed):
            raise ValueError("Unexpected archive files")
        for entry in entries:
            if entry.file_size > allowed[entry.filename] or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Unsafe archive entry")
        archive.extractall(directory)
    metadata = json.loads((directory / "image.json").read_text())
    repository = image_ref.rsplit(":", 1)[0]
    if (set(metadata) != {"image_ref", "image_digest", "image_id", "revision"} or
            metadata["image_ref"] != image_ref or metadata["revision"] != revision):
        raise ValueError("Archive belongs to a different image or revision")
    if (not re.fullmatch(re.escape(repository) + "@" + DIGEST, metadata["image_digest"]) or
            not re.fullmatch(DIGEST, metadata["image_id"])):
        raise ValueError("Invalid image digest or ID")
    receipt = (directory / "main-image.tar.gz.sha256").read_text().split()
    if receipt != [checksum(directory / "main-image.tar.gz"), "main-image.tar.gz"]:
        raise ValueError("Exported image checksum mismatch")
    identity = image_identity(directory / "main-image.tar.gz", image_ref, revision, metadata["image_digest"].rsplit("@", 1)[1])
    if metadata["image_id"] not in identity["identifiers"]:
        raise ValueError("Receipt image ID is not bound to the exported config")
    (directory / "verified-image.json").write_text(json.dumps(identity))
    return metadata["image_digest"], identity["config_id"]


def verify_loaded(directory, image_ref):
    identity = json.loads((directory / "verified-image.json").read_text())
    raw = subprocess.check_output(["docker", "image", "inspect", image_ref], text=True, timeout=30)
    images = json.loads(raw)
    if len(images) != 1:
        raise ValueError("Loaded image identity is ambiguous")
    image = images[0]
    if (image.get("Id") not in identity["identifiers"] or image.get("Os") != "linux" or
            image.get("Architecture") != "amd64" or
            image.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != identity["revision"]):
        raise ValueError("Loaded image differs from the authenticated archive config")
    # The local engine ID, not the producer's ID representation, is the pinned
    # reference used by this server's migration job and offline Swarm rollout.
    return image["Id"]


if __name__ == "__main__":
    directory = pathlib.Path(os.environ["ARCHIVE_DIR"])
    if sys.argv[1] == "archive":
        print(*verify_archive(directory, os.environ["IMAGE_ARCHIVE_DIGEST"], os.environ["IMAGE_REF"], os.environ["SOURCE_SHA"]))
    elif sys.argv[1] == "loaded":
        print(verify_loaded(directory, os.environ["IMAGE_REF"]))
    else:
        raise SystemExit("Unsupported image verification mode")
