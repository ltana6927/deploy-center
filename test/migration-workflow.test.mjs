import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const steps = workflow.jobs.deploy.steps;
const migration = steps.find(step => step.id === "migrations");
const update = steps.find(step => step.name === "Update Swarm service");

test("migration is a mandatory success gate between image verification and Swarm update", () => {
  assert.ok(steps.indexOf(steps.find(step => step.id === "image")) < steps.indexOf(migration));
  assert.ok(steps.indexOf(migration) < steps.indexOf(update));
  assert.match(migration.if, /database_migration == 'drizzle'/);
  assert.match(migration.if, /github.event.action != 'verify-image-archive'/);
  assert.doesNotMatch(migration.if, /already_deployed|always\(|failure\(/);
  assert.equal(migration["continue-on-error"], undefined);
  assert.doesNotMatch(update.if, /always\(|failure\(/);
  assert.equal(migration.env.ROLLOUT_IMAGE, "${{ steps.image.outputs.rollout_image }}");
});

test("a failed migration command never reaches Swarm update", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deploy-migration-order-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const log = join(directory, "calls");
  for (const name of ["python3", "docker"]) {
    await writeFile(join(directory, name), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.ORDER_LOG, ${JSON.stringify(name)} + '\\n');
process.exit(${name === "python3" ? "Number(process.env.MIGRATION_EXIT)" : "0"});
`, {mode: 0o700});
  }
  for (const status of [0, 7]) {
    await writeFile(log, "");
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${migration.run}\n${update.run}`], {
      encoding: "utf8", timeout: 10000,
      env: {...process.env, PATH: `${directory}:${process.env.PATH}`, ORDER_LOG: log, MIGRATION_EXIT: String(status),
        DEPLOY_SCRIPT_DIR: directory, IMAGE_SOURCE: "registry", ROLLOUT_IMAGE: "verified-image", SWARM_SERVICE: "app_example-api"},
    });
    assert.equal(result.status, status, result.stderr);
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(calls, status === 0 ? ["python3", "docker"] : ["python3"]);
  }
});
