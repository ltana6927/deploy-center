import gzip
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("image_archive", pathlib.Path(__file__).parents[1] / "scripts/verify-image-archive.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
REVISION = "a" * 40
IMAGE_REF = "ghcr.io/ltana6927/example/api:" + REVISION


def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)

    def fixture(self, containerd=False, config_changes=None, receipt_changes=None,
                tag=IMAGE_REF, corrupt_descriptor=False, unrelated_config=False,
                duplicate_config=False, unsafe_member=False):
        config = {"architecture": "amd64", "os": "linux", "config": {"Labels": {"org.opencontainers.image.revision": REVISION}},
                  "rootfs": {"type": "layers", "diff_ids": []}}
        config.update(config_changes or {})
        raw = json.dumps(config).encode()
        config_id = digest(raw)
        config_name = "blobs/sha256/" + config_id[7:] if containerd else config_id[7:] + ".json"
        files = [(config_name, raw)]
        registry_id = digest(b"authenticated registry receipt")
        if containerd:
            manifest = json.dumps({"schemaVersion": 2, "config": {"digest": digest(b"other") if unrelated_config else config_id}, "layers": []}).encode()
            manifest_id = digest(manifest)
            files.append(("blobs/sha256/" + manifest_id[7:], manifest + b" " if corrupt_descriptor else manifest))
            index = json.dumps({"schemaVersion": 2, "manifests": [{"digest": manifest_id, "platform": {"os": "linux", "architecture": "amd64"}}]}).encode()
            registry_id = digest(index)
            files.append(("blobs/sha256/" + registry_id[7:], index))
        files.append(("manifest.json", json.dumps([{"Config": config_name, "RepoTags": [tag], "Layers": []}]).encode()))
        if duplicate_config:
            files.append((config_name, raw))
        if unsafe_member:
            files.append(("../unsafe", b"bad"))
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            for name, value in files:
                member = tarfile.TarInfo(name)
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
        data = gzip.compress(stream.getvalue())
        receipt = {"image_ref": IMAGE_REF, "image_digest": IMAGE_REF.rsplit(":", 1)[0] + "@" + registry_id,
                   "image_id": registry_id if containerd else config_id, "revision": REVISION}
        receipt.update(receipt_changes or {})
        with zipfile.ZipFile(self.directory / "image.zip", "w") as archive:
            archive.writestr("main-image.tar.gz", data)
            archive.writestr("main-image.tar.gz.sha256", digest(data)[7:] + "  main-image.tar.gz")
            archive.writestr("image.json", json.dumps(receipt))
        return config_id, registry_id

    def verify(self):
        return verifier.verify_archive(self.directory, "sha256:" + verifier.checksum(self.directory / "image.zip"), IMAGE_REF, REVISION)

    def loaded(self, image_id, **changes):
        image = {"Id": image_id, "Os": "linux", "Architecture": "amd64", "Config": {"Labels": {"org.opencontainers.image.revision": REVISION}}}
        image.update(changes)
        with patch.object(verifier.subprocess, "check_output", return_value=json.dumps([image])):
            return verifier.verify_loaded(self.directory, IMAGE_REF)

    def test_classic_receipt_uses_canonical_config_identity(self):
        config_id, registry_id = self.fixture()
        self.assertEqual(self.verify(), (IMAGE_REF.rsplit(":", 1)[0] + "@" + registry_id, config_id))
        self.assertEqual(self.loaded(config_id), config_id)

    def test_containerd_index_receipt_can_load_into_classic_and_containerd_stores(self):
        config_id, registry_id = self.fixture(containerd=True)
        self.assertNotEqual(config_id, registry_id)
        self.assertEqual(self.verify()[1], config_id)
        self.assertEqual(self.loaded(config_id), config_id)
        self.assertEqual(self.loaded(registry_id), registry_id)

    def test_new_canonical_receipt_can_describe_an_oci_archive(self):
        config_id, _ = self.fixture(containerd=True)
        self.fixture(containerd=True, receipt_changes={"image_id": config_id})
        self.assertEqual(self.verify()[1], config_id)

    def test_unbound_receipt_id_and_oci_config_mismatch_fail_closed(self):
        for options in [{"receipt_changes": {"image_id": digest(b"unrelated ID")}},
                        {"containerd": True, "unrelated_config": True},
                        {"containerd": True, "corrupt_descriptor": True}]:
            with self.subTest(options=options):
                self.fixture(**options)
                with self.assertRaises(ValueError):
                    self.verify()
                self.assertFalse((self.directory / "verified-image.json").exists())

    def test_wrong_tag_platform_revision_and_unsafe_tar_fail_before_load(self):
        for options in [{"tag": "wrong:tag"}, {"config_changes": {"architecture": "arm64"}},
                        {"config_changes": {"config": {"Labels": {"org.opencontainers.image.revision": "wrong"}}}},
                        {"duplicate_config": True}, {"unsafe_member": True}]:
            with self.subTest(options=options):
                self.fixture(**options)
                with self.assertRaises(ValueError):
                    self.verify()

    def test_loaded_image_must_match_verified_identity_platform_and_revision(self):
        config_id, _ = self.fixture()
        self.verify()
        for image_id, changes in [(digest(b"wrong loaded image"), {}), (config_id, {"Architecture": "arm64"}),
                                  (config_id, {"Config": {"Labels": {"org.opencontainers.image.revision": "wrong"}}})]:
            with self.subTest(image_id=image_id, changes=changes):
                with self.assertRaises(ValueError):
                    self.loaded(image_id, **changes)

    def test_artifact_corruption_clears_prior_verification_state(self):
        self.fixture()
        self.verify()
        with self.assertRaisesRegex(ValueError, "artifact checksum"):
            verifier.verify_archive(self.directory, digest(b"wrong ZIP"), IMAGE_REF, REVISION)
        self.assertFalse((self.directory / "verified-image.json").exists())


if __name__ == "__main__":
    unittest.main()
