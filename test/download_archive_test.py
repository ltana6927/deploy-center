import importlib.util
import pathlib
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "downloader", pathlib.Path(__file__).parents[1] / "scripts/download-archive.py"
)
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


class URLProvider:
    def __init__(self, url):
        self.url = url
        self.invalidations = 0

    def __call__(self):
        return self.url

    def invalidate(self, url):
        self.invalidations += 1


class ArtifactURLTest(unittest.TestCase):
    def test_storage_redirect_is_received_without_following_with_the_token(self):
        location = "https://example.blob.core.windows.net/artifact?test-signature"
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "https://api.github.com", 302, "redirect", {"Location": location}, None
        )
        with mock.patch.object(downloader.urllib.request, "build_opener", return_value=opener) as factory:
            provider = downloader.ArtifactURL("ltana6927/example", "456", "test-only")
            self.assertEqual(provider(), location)
            self.assertEqual(provider(), location)
        self.assertIsInstance(factory.call_args.args[0], downloader.NoRedirect)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.github.com/repos/ltana6927/example/actions/artifacts/456/zip")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-only")
        self.assertEqual(opener.open.call_count, 1)
        self.assertIsNone(downloader.NoRedirect().redirect_request(request, None, 302, "redirect", {}, location))

    def test_non_https_redirects_are_rejected(self):
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            "https://api.github.com", 302, "redirect", {"Location": "http://storage.invalid"}, None
        )
        with mock.patch.object(downloader.urllib.request, "build_opener", return_value=opener), mock.patch.object(downloader.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "Unable to obtain"):
                downloader.ArtifactURL("ltana6927/example", "456", "test-only")()


class RangeDownloadTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = pathlib.Path(self.directory.name)
        self.data = bytes(range(256)) * 64
        self.requests = []
        self.mode = "normal"
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()
        state = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                start, end = map(int, self.headers["Range"].removeprefix("bytes=").split("-"))
                with state.lock:
                    number = len(state.requests)
                    state.requests.append((start, end, self.headers.get("Authorization")))
                    state.active += 1
                    state.peak = max(state.peak, state.active)
                try:
                    time.sleep(0.03)
                    if state.mode == "expired" and number == 0:
                        self.send_response(403)
                        self.end_headers()
                        return
                    self.send_response(200 if state.mode == "ignore-range" else 206)
                    offset = start + 1 if state.mode == "wrong-range" else start
                    self.send_header("Content-Range", f"bytes {offset}-{end}/{len(state.data)}")
                    self.send_header("Content-Length", str(end - start + 1))
                    self.end_headers()
                    data = state.data[start:end + 1]
                    if state.mode == "eof" and number == 0:
                        data = data[:len(data) // 2]
                    self.wfile.write(data)
                    self.wfile.flush()
                    if state.mode == "eof" and number == 0:
                        self.connection.shutdown(socket.SHUT_RDWR)
                finally:
                    with state.lock:
                        state.active -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.provider = URLProvider(f"http://127.0.0.1:{self.server.server_port}/archive")

    def transfer(self, url, start, end, directory, index):
        # Production enforces HTTPS. This test exercises real curl range handling
        # over an isolated loopback fixture, without credentials or public calls.
        return downloader.transfer(url, start, end, directory, index, protocol="=http")

    def download(self, **kwargs):
        downloader.download(self.path, len(self.data), self.provider, workers=4,
                            attempts=3, retry_delay=0, transport=self.transfer, **kwargs)

    def test_parallel_ranges_reassemble_exact_bytes_without_credentials(self):
        self.download()
        self.assertEqual((self.path / "image.zip").read_bytes(), self.data)
        self.assertGreater(self.peak, 1)
        self.assertEqual(len(self.requests), 4)
        self.assertTrue(all(auth is None for _, _, auth in self.requests))
        self.assertEqual(list(self.path.glob("*.part")), [])

    def test_eof_keeps_valid_partial_bytes_and_resumes_at_the_next_byte(self):
        self.mode = "eof"
        self.download()
        start, end, _ = self.requests[0]
        expected = start + (end - start + 1) // 2
        self.assertIn((expected, end, None), self.requests)
        self.assertEqual((self.path / "image.zip").read_bytes(), self.data)

    def test_expired_signed_url_is_refreshed(self):
        self.mode = "expired"
        self.download()
        self.assertEqual(self.provider.invalidations, 1)
        self.assertEqual((self.path / "image.zip").read_bytes(), self.data)

    def test_ignored_or_incorrect_range_cannot_be_appended(self):
        for mode in ("ignore-range", "wrong-range"):
            with self.subTest(mode=mode):
                self.mode = mode
                with self.assertRaises(RuntimeError):
                    self.download()
                self.assertFalse((self.path / "image.zip").exists())
                self.assertEqual(list(self.path.glob("*.part")), [])


if __name__ == "__main__":
    unittest.main()
