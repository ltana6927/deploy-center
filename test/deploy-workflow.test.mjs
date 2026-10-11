import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  await readFile(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  ),
);
const imageStep = workflow.jobs.deploy.steps.find(
  (step) => step.id === "image",
);
const nativePython = spawnSync(
  "python3",
  ["-c", "import sys; print(sys.executable)"],
  { encoding: "utf8" },
).stdout.trim();

test("the image execution step receives every archive recovery input", () => {
  for (const name of [
    "SOURCE_REPO",
    "SOURCE_READ_TOKEN",
    "IMAGE_ARCHIVE_ID",
    "IMAGE_ARCHIVE_DIGEST",
    "IMAGE_ARCHIVE_SIZE",
    "IMAGE_RECOVERY_ONLY",
  ]) {
    assert.ok(
      Object.hasOwn(imageStep.env, name),
      `Missing image-step environment: ${name}`,
    );
  }
  assert.match(
    imageStep.env.IMAGE_RECOVERY_ONLY,
    /github\.event\.action == 'verify-image-archive'/,
  );
});
test("the server checks out the trusted downloader without persisting credentials", () => {
  const checkout = workflow.jobs.deploy.steps.find(
    (step) => step.uses === "actions/checkout@v5",
  );
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(
    imageStep.run,
    /python3 "\$\{GITHUB_WORKSPACE\}\/scripts\/download-archive\.py"/,
  );
  assert.equal(
    imageStep.env.IMAGE_ARCHIVE_SIZE,
    "${{ needs.validate.outputs.image_archive_size }}",
  );
});
const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PULL_TEST_LOG, JSON.stringify({ name, args }) + "\\n");
if (name === "python3") {
  if (args[0].endsWith("/scripts/download-archive.py")) {
    fs.copyFileSync(process.env.PULL_TEST_ARCHIVE, path.join(process.env.ARCHIVE_DIR, "image.zip"));
    process.exit(0);
  }
  const result = spawnSync(process.env.PULL_TEST_NATIVE_PYTHON, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (name === "timeout") {
  const result = spawnSync(args[3], args.slice(4), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (name === "sleep") process.exit(0);
if (name === "curl") {
  const countPath = process.env.PULL_TEST_COUNT + ".curl";
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
  fs.writeFileSync(countPath, String(count + 1));
  const output = args[args.indexOf("--output") + 1];
  if (process.env.PULL_TEST_DOWNLOAD_FAILURE && count === 0) {
    fs.writeFileSync(output, "partial archive");
    process.exit(18);
  }
  fs.copyFileSync(process.env.PULL_TEST_ARCHIVE, output);
  process.exit(0);
}
if (args[0] === "pull") {
  const count = fs.existsSync(process.env.PULL_TEST_COUNT) ? Number(fs.readFileSync(process.env.PULL_TEST_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.PULL_TEST_COUNT, String(count + 1));
  if (process.env.PULL_TEST_FAILURE === "always" || (process.env.PULL_TEST_FAILURE === "first" && count === 0)) process.exit(1);
} else if (args[0] === "image") {
  console.log(args.includes("{{ .Id }}") ? (process.env.PULL_TEST_IMAGE_ID ?? "sha256:" + "c".repeat(64)) : args.includes("{{ index .RepoDigests 0 }}") ? process.env.PULL_TEST_DIGEST : (process.env.PULL_TEST_REVISION ?? process.env.SOURCE_SHA));
} else if (args[0] === "service") {
  console.log(process.env.PULL_TEST_CURRENT ?? "old-image");
}
`;

async function run(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deploy-pull-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await Promise.all(
    ["docker", "timeout", "sleep", "curl", "python3"].map((name) =>
      writeFile(join(bin, name), stub, { mode: 0o700 }),
    ),
  );
  const output = join(directory, "output");
  await writeFile(output, "");
  const digest = `ghcr.io/ltana6927/example/api@sha256:${"b".repeat(64)}`;
  const result = spawnSync("bash", ["-c", imageStep.run], {
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IMAGE_REF: `ghcr.io/ltana6927/example/api:${"a".repeat(40)}`,
      SOURCE_SHA: "a".repeat(40),
      SWARM_SERVICE: "app_example-api",
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: directory,
      SOURCE_REPO: "ltana6927/example",
      SOURCE_READ_TOKEN: "test-only",
      IMAGE_ARCHIVE_ID: "",
      IMAGE_ARCHIVE_DIGEST: "",
      IMAGE_ARCHIVE_SIZE: "",
      IMAGE_RECOVERY_ONLY: "false",
      GITHUB_WORKSPACE: process.cwd(),
      PULL_TEST_NATIVE_PYTHON: nativePython,
      PULL_TEST_LOG: join(directory, "calls"),
      PULL_TEST_COUNT: join(directory, "count"),
      PULL_TEST_DIGEST: digest,
      ...overrides,
    },
  });
  const calls = (await readFile(join(directory, "calls"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  return { ...result, calls, output: await readFile(output, "utf8"), digest };
}

test("an interrupted pull retries and only then verifies the immutable image", async (t) => {
  const result = await run(t, { PULL_TEST_FAILURE: "first" });
  assert.equal(result.status, 0, result.stderr);
  const pulls = result.calls.filter((call) => call.name === "timeout");
  assert.equal(pulls.length, 2);
  assert.deepEqual(pulls[0].args.slice(0, 3), [
    "--signal=TERM",
    "--kill-after=30s",
    "20m",
  ]);
  assert.ok(result.calls.some((call) => call.name === "sleep"));
  assert.ok(result.output.includes(`image_digest=${result.digest}`));
  assert.ok(result.output.includes("already_deployed=false"));
});

test("exhausted pulls fail without accepting a cached image", async (t) => {
  const result = await run(t, { PULL_TEST_FAILURE: "always" });
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.equal(
    result.calls.filter((call) => call.name === "timeout").length,
    2,
  );
  assert.ok(
    !result.calls.some(
      (call) => call.name === "docker" && call.args[0] !== "pull",
    ),
  );
});

test("a successful pull still rejects a mismatched revision", async (t) => {
  const result = await run(t, { PULL_TEST_REVISION: "c".repeat(40) });
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /revision label/);
});

test("a verified running digest remains idempotent", async (t) => {
  const digest = `ghcr.io/ltana6927/example/api@sha256:${"b".repeat(64)}`;
  const result = await run(t, { PULL_TEST_CURRENT: digest });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.output.includes("already_deployed=true"));
  assert.equal(
    result.calls.filter((call) => call.name === "timeout").length,
    1,
  );
});

test("the job reserves time for both image downloads and subsequent deployment", () => {
  const update = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Update Swarm service",
  );
  const health = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Verify public health endpoint",
  );
  assert.ok(imageStep["timeout-minutes"] > 2 * 20 + 2 * 0.5 + 15 / 60);
  assert.ok(
    workflow.jobs.deploy["timeout-minutes"] >
      imageStep["timeout-minutes"] +
        update["timeout-minutes"] +
        health["timeout-minutes"],
  );
});

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "archive-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, "fixture.zip");
  const metadata = {
    image_ref: `ghcr.io/ltana6927/example/api:${"a".repeat(40)}`,
    image_digest: `ghcr.io/ltana6927/example/api@sha256:${"b".repeat(64)}`,
    image_id: `sha256:${"c".repeat(64)}`,
    revision: "a".repeat(40),
    ...overrides,
  };
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import hashlib, json, sys, zipfile
data = b'test exported image'
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
 archive.writestr('main-image.tar.gz', data)
 archive.writestr('main-image.tar.gz.sha256', hashlib.sha256(data).hexdigest() + '  main-image.tar.gz')
 archive.writestr('image.json', sys.argv[2])`,
      archive,
      JSON.stringify(metadata),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return {
    PULL_TEST_ARCHIVE: archive,
    IMAGE_ARCHIVE_ID: "456",
    IMAGE_ARCHIVE_SIZE: String((await readFile(archive)).length),
    IMAGE_ARCHIVE_DIGEST: `sha256:${createHash("sha256")
      .update(await readFile(archive))
      .digest("hex")}`,
  };
}

test("registry interruption automatically recovers the bound archive through the range downloader", async (t) => {
  const result = await run(t, {
    ...(await fixture(t)),
    PULL_TEST_FAILURE: "first",
  });
  assert.equal(result.status, 0, result.stderr);
  const downloads = result.calls.filter(
    (call) =>
      call.name === "python3" &&
      call.args[0].endsWith("/scripts/download-archive.py"),
  );
  assert.equal(downloads.length, 1);
  assert.equal(
    result.calls.find((call) => call.name === "timeout").args[2],
    "3m",
  );
  assert.equal(
    result.calls.filter(
      (call) => call.name === "docker" && call.args[0] === "load",
    ).length,
    1,
  );
  assert.ok(result.output.includes(`image_digest=${result.digest}`));
});

test("tampered artifact bytes fail before Docker load or service updates", async (t) => {
  const result = await run(t, {
    ...(await fixture(t)),
    IMAGE_ARCHIVE_DIGEST: `sha256:${"d".repeat(64)}`,
    PULL_TEST_FAILURE: "first",
  });
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.ok(
    !result.calls.some(
      (call) => call.name === "docker" && call.args[0] === "load",
    ),
  );
});

test("archive metadata for another revision or registry is rejected before loading", async (t) => {
  for (const metadata of [
    { revision: "d".repeat(40) },
    { image_digest: `ghcr.io/attacker/api@sha256:${"b".repeat(64)}` },
  ]) {
    const result = await run(t, {
      ...(await fixture(t, metadata)),
      PULL_TEST_FAILURE: "first",
    });
    assert.equal(result.status, 1);
    assert.equal(result.output, "");
    assert.ok(
      !result.calls.some(
        (call) => call.name === "docker" && call.args[0] === "load",
      ),
    );
  }
});

test("loaded image identity must equal the authenticated archive identity", async (t) => {
  const result = await run(t, {
    ...(await fixture(t)),
    PULL_TEST_FAILURE: "first",
    PULL_TEST_IMAGE_ID: `sha256:${"d".repeat(64)}`,
  });
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.match(result.stderr, /Loaded image ID/);
});

test("archive verification exercises the download path without rolling out a service", async (t) => {
  const result = await run(t, {
    ...(await fixture(t)),
    IMAGE_RECOVERY_ONLY: "true",
  });
  assert.equal(result.status, 0, result.stderr);
  const docker = result.calls.filter((call) => call.name === "docker");
  assert.equal(docker[0].args[0], "load");
  const update = workflow.jobs.deploy.steps.find(
    (step) => step.name === "Update Swarm service",
  );
  assert.match(update.if, /github\.event\.action != 'verify-image-archive'/);
});
