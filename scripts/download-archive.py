"""Download a validated build artifact with bounded, resumable parallel ranges."""

import concurrent.futures
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


class ArtifactURL:
    """Keep the source-read credential on GitHub; refresh expiring storage URLs."""

    def __init__(self, repository, artifact_id, token):
        self.api_url = (
            f"https://api.github.com/repos/{repository}/actions/artifacts/{artifact_id}/zip"
        )
        self.token = token
        self.lock = threading.Lock()
        self.url = None
        self.updated = 0

    def __call__(self):
        with self.lock:
            if self.url and time.monotonic() - self.updated < 300:
                return self.url
            request = urllib.request.Request(
                self.api_url,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/vnd.github+json",
                    "User-Agent": "deploy-center-image-recovery",
                },
            )
            opener = urllib.request.build_opener(NoRedirect())
            for attempt in range(3):
                try:
                    with opener.open(request, timeout=20):
                        raise RuntimeError("Artifact endpoint did not redirect")
                except urllib.error.HTTPError as error:
                    location = error.headers.get("Location", "")
                    code = error.code
                    error.close()
                    parsed = urllib.parse.urlsplit(location)
                    if (
                        code == 302
                        and parsed.scheme == "https"
                        and parsed.hostname
                        and not parsed.username
                        and not parsed.password
                    ):
                        self.url = location
                        self.updated = time.monotonic()
                        return location
                except (OSError, urllib.error.URLError):
                    pass
                if attempt < 2:
                    time.sleep(5)
            # Do not expose authorization or signed URLs in exception output.
            raise RuntimeError("Unable to obtain the build artifact download URL")

    def invalidate(self, url):
        with self.lock:
            if self.url == url:
                self.url = None


def transfer(url, start, end, directory, index, protocol="=https"):
    body = directory / f"range-{index}.body"
    headers = directory / f"range-{index}.headers"
    result = subprocess.run([
        "curl", "--proto", protocol, "--fail", "--silent", "--show-error",
        "--connect-timeout", "15", "--max-time", "240",
        "--speed-time", "45", "--speed-limit", "1024",
        "--range", f"{start}-{end}", "--max-filesize", str(end - start + 1),
        "--dump-header", str(headers), "--output", str(body),
        "--write-out", "%{http_code}", "--config", "-",
    ], input=f"url = {json.dumps(url)}\n", capture_output=True, text=True)
    status = result.stdout.strip()
    header_text = headers.read_text() if headers.exists() else ""
    ranges = re.findall(
        r"^content-range:\s*bytes (\d+)-(\d+)/(\d+)\s*$", header_text, re.I | re.M
    )
    return body, status, tuple(map(int, ranges[-1])) if ranges else None


def download(
    directory, size, url_provider, workers=8, attempts=8,
    retry_delay=5, transport=transfer,
):
    if not isinstance(size, int) or not 0 < size <= 2 ** 30 or not 1 <= workers <= 8:
        raise ValueError("Invalid artifact size or download concurrency")
    count = min(workers, size)
    width = math.ceil(size / count)
    parts = [(start, min(start + width, size) - 1) for start in range(0, size, width)]

    def download_part(index, start, end):
        part = directory / f"range-{index}.part"
        for attempt in range(attempts):
            offset = start + (part.stat().st_size if part.exists() else 0)
            url = url_provider()
            body, status, received_range = transport(url, offset, end, directory, index)
            length = body.stat().st_size if body.exists() else 0
            # Partial 206 bodies survive EOF/timeouts only when their range is exact.
            if (
                status == "206"
                and received_range == (offset, end, size)
                and 0 < length <= end - offset + 1
            ):
                with part.open("ab") as target, body.open("rb") as source:
                    shutil.copyfileobj(source, target)
            elif status in ("401", "403"):
                url_provider.invalidate(url)
            body.unlink(missing_ok=True)
            (directory / f"range-{index}.headers").unlink(missing_ok=True)
            if part.exists() and part.stat().st_size == end - start + 1:
                print(f"Download range {index + 1}/{len(parts)} complete", flush=True)
                return part
            if attempt + 1 < attempts:
                time.sleep(retry_delay)
        raise RuntimeError(f"Artifact range {index + 1} failed after bounded retries")

    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
        futures = [
            executor.submit(download_part, index, start, end)
            for index, (start, end) in enumerate(parts)
        ]
        completed = [future.result() for future in futures]
    with (directory / "image.zip").open("wb") as output:
        for part in completed:
            with part.open("rb") as source:
                shutil.copyfileobj(source, output)
            part.unlink()


if __name__ == "__main__":
    os.umask(0o077)
    download(
        pathlib.Path(os.environ["ARCHIVE_DIR"]),
        int(os.environ["IMAGE_ARCHIVE_SIZE"]),
        ArtifactURL(
            os.environ["SOURCE_REPO"], os.environ["IMAGE_ARCHIVE_ID"],
            os.environ["SOURCE_READ_TOKEN"],
        ),
    )
