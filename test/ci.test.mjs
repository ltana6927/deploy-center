import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("pull-request checks run all test lanes without production runners or secrets", async () => {
  const text = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const ci = parse(text);
  assert.ok(ci.on.pull_request);
  assert.equal(ci.on.pull_request_target, undefined);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.ok(!text.includes("secrets."));
  for (const job of Object.values(ci.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.ok(job.steps.some((step) => step.run === "npm ci"));
  }
  const commands = Object.values(ci.jobs).flatMap((job) => job.steps.map((step) => step.run));
  assert.ok(commands.includes("npm test"));
  assert.ok(commands.includes("npm run test:swarm"));
  const deploy = parse(await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(deploy.on), ["repository_dispatch"]);
});
