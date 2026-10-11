import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const imageStep = workflow.jobs.deploy.steps.find((step) => step.id === "image");
const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PULL_TEST_LOG, JSON.stringify({ name, args }) + "\\n");
if (name === "timeout") {
  const result = spawnSync(args[3], args.slice(4), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (name === "sleep") process.exit(0);
if (args[0] === "pull") {
  const count = fs.existsSync(process.env.PULL_TEST_COUNT) ? Number(fs.readFileSync(process.env.PULL_TEST_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.PULL_TEST_COUNT, String(count + 1));
  if (process.env.PULL_TEST_FAILURE === "always" || (process.env.PULL_TEST_FAILURE === "first" && count === 0)) process.exit(1);
} else if (args[0] === "image") {
  console.log(args.includes("{{ index .RepoDigests 0 }}") ? process.env.PULL_TEST_DIGEST : (process.env.PULL_TEST_REVISION ?? process.env.SOURCE_SHA));
} else if (args[0] === "service") {
  console.log(process.env.PULL_TEST_CURRENT ?? "old-image");
}
`;

async function run(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deploy-pull-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await Promise.all(["docker", "timeout", "sleep"].map((name) => writeFile(join(bin, name), stub, { mode: 0o700 })));
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
      PULL_TEST_LOG: join(directory, "calls"),
      PULL_TEST_COUNT: join(directory, "count"),
      PULL_TEST_DIGEST: digest,
      ...overrides,
    },
  });
  const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
  return { ...result, calls, output: await readFile(output, "utf8"), digest };
}

test("an interrupted pull retries and only then verifies the immutable image", async (t) => {
  const result = await run(t, { PULL_TEST_FAILURE: "first" });
  assert.equal(result.status, 0, result.stderr);
  const pulls = result.calls.filter((call) => call.name === "timeout");
  assert.equal(pulls.length, 2);
  assert.deepEqual(pulls[0].args.slice(0, 3), ["--signal=TERM", "--kill-after=30s", "20m"]);
  assert.ok(result.calls.some((call) => call.name === "sleep"));
  assert.ok(result.output.includes(`image_digest=${result.digest}`));
  assert.ok(result.output.includes("already_deployed=false"));
});

test("exhausted pulls fail without accepting a cached image", async (t) => {
  const result = await run(t, { PULL_TEST_FAILURE: "always" });
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
  assert.equal(result.calls.filter((call) => call.name === "timeout").length, 2);
  assert.ok(!result.calls.some((call) => call.name === "docker" && call.args[0] !== "pull"));
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
  assert.equal(result.calls.filter((call) => call.name === "timeout").length, 1);
});

test("the job reserves time for both image downloads and subsequent deployment", () => {
  const update = workflow.jobs.deploy.steps.find((step) => step.name === "Update Swarm service");
  const health = workflow.jobs.deploy.steps.find((step) => step.name === "Verify public health endpoint");
  assert.ok(imageStep["timeout-minutes"] > 2 * 20 + 2 * 0.5 + 15 / 60);
  assert.ok(workflow.jobs.deploy["timeout-minutes"] > imageStep["timeout-minutes"] + update["timeout-minutes"] + health["timeout-minutes"]);
});
