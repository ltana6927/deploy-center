import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8"));
const notify = workflow.jobs.notify;
const step = notify.steps[0];

async function send(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "deploy-notify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const payload = join(directory, "payload");
  await mkdir(bin);
  await writeFile(join(bin, "curl"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.NOTIFY_TEST_PAYLOAD, args[args.indexOf("--data") + 1]);
console.log(JSON.stringify({code:0,msg:"success"}));
`, { mode: 0o700 });
  const result = spawnSync("bash", ["-c", step.run], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOTIFY_TEST_PAYLOAD: payload,
      BUILD_STATUS: "success", DEPLOY_STATUS: "success", VALIDATE_STATUS: "success", DISPLAY_NAME: "Example API",
      FEISHU_WEBHOOK: "https://feishu.invalid/test-only", SOURCE_REPO: "ltana6927/example", SOURCE_SHA: "a".repeat(40),
      SOURCE_RUN_URL: "https://github.com/ltana6927/example/actions/runs/123",
      DEPLOY_RUN_URL: "https://github.com/ltana6927/deploy-center/actions/runs/456",
      REHEARSE_ARCHIVE_RECOVERY: "true", ...overrides },
  });
  return { ...result, payload };
}

test("authenticated rehearsal sends a clearly identified success card through the deployment notification job", async (t) => {
  assert.ok(workflow.on.repository_dispatch.types.includes("rehearse-archive-deploy"));
  assert.match(notify.if, /github\.event\.action == 'rehearse-archive-deploy'/);
  const result = await send(t);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(await readFile(result.payload, "utf8"));
  assert.equal(payload.card.header.template, "green");
  assert.equal(payload.card.header.title.content, "Example API (archive recovery rehearsal): Deployment succeeded");
  assert.match(payload.card.elements[0].text.content, /\*\*Deploy:\*\* success/);
  assert.equal(payload.card.elements[1].actions[1].url, "https://github.com/ltana6927/deploy-center/actions/runs/456");
});

test("rehearsal cannot report successful notification without a webhook", async (t) => {
  const result = await send(t, { FEISHU_WEBHOOK: "" });
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(result.payload));
});
