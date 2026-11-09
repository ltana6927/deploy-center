import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const step = workflow.jobs.deploy.steps.find((step) => step.name === "Fetch trusted deployment scripts");
const revision = "a".repeat(40);
const fixture = `
import base64, hashlib, json, os, pathlib, urllib.error, urllib.parse, urllib.request
mode = os.environ['SCRIPT_TEST_MODE']
calls = []
class Response:
    def __init__(self, raw): self.raw = raw
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, maximum): return self.raw[:maximum]
class Opener:
    def open(self, request, timeout):
        calls.append(request.full_url)
        pathlib.Path(os.environ['SCRIPT_TEST_CALLS']).write_text(json.dumps(calls))
        assert request.get_header('Authorization') == 'Bearer test-only-secret'
        assert timeout == 20
        if mode == 'unavailable' or (mode == 'retry' and len(calls) < 3):
            raise urllib.error.URLError('test-only-secret must not be logged')
        if mode == 'redirect':
            raise urllib.error.HTTPError(request.full_url, 302, 'test', {'Location':'https://untrusted.invalid/file'}, None)
        parsed = urllib.parse.urlsplit(request.full_url)
        assert parsed.scheme == 'https' and parsed.hostname == 'api.github.com'
        assert urllib.parse.parse_qs(parsed.query) == {'ref': ['${revision}']}
        path = parsed.path.split('/contents/')[1]
        content = (pathlib.Path(os.environ['SCRIPT_TEST_ROOT']) / path).read_bytes()
        if mode == 'large-content': content = b'x' * (64 * 1024 + 1)
        blob = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\\0' + content).hexdigest()
        metadata = {'type':'file','encoding':'base64','path':path,'size':len(content),'sha':blob,'content':base64.encodebytes(content).decode()}
        if mode == 'wrong-path': metadata['path'] = '../../other.py'
        if mode == 'wrong-blob': metadata['sha'] = 'f' * 40
        if mode == 'wrong-size': metadata['size'] += 1
        if mode == 'wrong-type': metadata['type'] = 'symlink'
        if mode == 'invalid-base64': metadata['content'] = '!invalid!'
        raw = b'x' * (128 * 1024 + 1) if mode == 'large-response' else json.dumps(metadata).encode()
        return Response(raw)
def build_opener(handler):
    assert handler.redirect_request(None, None, 302, 'test', {}, 'https://untrusted.invalid') is None
    return Opener()
urllib.request.build_opener = build_opener
import time
time.sleep = lambda seconds: None
`;

async function run(t, mode = "valid", overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deploy-controller-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "env");
  const calls = join(directory, "calls");
  await writeFile(output, "");
  await writeFile(calls, "[]");
  const result = spawnSync("python3", ["-c", fixture + "\n" + step.run], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, CONTROLLER_REPO: "ltana6927/deploy-center", CONTROLLER_SHA: revision,
      CONTROLLER_READ_TOKEN: "test-only-secret", RUNNER_TEMP: directory, GITHUB_ENV: output,
      SCRIPT_TEST_MODE: mode, SCRIPT_TEST_ROOT: process.cwd(), SCRIPT_TEST_CALLS: calls, ...overrides },
  });
  assert.ok(!result.stdout.includes("test-only-secret"));
  assert.ok(!result.stderr.includes("test-only-secret"));
  return { ...result, directory, output: await readFile(output, "utf8"), calls: JSON.parse(await readFile(calls, "utf8")) };
}

test("production fetches only the two trusted scripts at the workflow commit with its temporary read-only token", async (t) => {
  assert.equal(step.env.CONTROLLER_SHA, "${{ github.sha }}");
  assert.equal(step.env.CONTROLLER_REPO, "${{ github.repository }}");
  assert.equal(step.env.CONTROLLER_READ_TOKEN, "${{ github.token }}");
  assert.equal(step.shell, "python3 {0}");
  const result = await run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2);
  const directory = result.output.trim().slice("DEPLOY_SCRIPT_DIR=".length);
  assert.deepEqual((await readdir(directory)).sort(), ["download-archive.py", "verify-local-swarm.py"]);
  for (const name of await readdir(directory))
    assert.deepEqual(await readFile(join(directory, name)), await readFile(join(process.cwd(), "scripts", name)));
});

test("untrusted controller identities fail before any API call or script publication", async (t) => {
  for (const overrides of [{ CONTROLLER_REPO: "other/deploy-center" }, { CONTROLLER_SHA: "main" }]) {
    const result = await run(t, "valid", overrides);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
    assert.equal(result.output, "");
  }
});

test("network failures are bounded and retried without exposing the credential", async (t) => {
  const recovered = await run(t, "retry");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.calls.length, 4);
  const failed = await run(t, "unavailable");
  assert.notEqual(failed.status, 0);
  assert.equal(failed.calls.length, 3);
  assert.equal(failed.output, "");
});

test("redirects cannot forward credentials to another host", async (t) => {
  const result = await run(t, "redirect");
  assert.notEqual(result.status, 0);
  assert.equal(result.calls.length, 3);
  assert.ok(result.calls.every((url) => new URL(url).hostname === "api.github.com"));
  assert.equal(result.output, "");
});

test("incorrect paths, types, sizes and blob identities cannot publish deployment code", async (t) => {
  for (const mode of ["wrong-path", "wrong-type", "wrong-size", "wrong-blob", "invalid-base64", "large-content", "large-response"]) {
    const result = await run(t, mode);
    assert.notEqual(result.status, 0, mode);
    assert.equal(result.output, "", mode);
    assert.deepEqual((await readdir(result.directory)).sort(), ["calls", "env"]);
  }
});
