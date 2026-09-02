import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../worker/src/index.mjs";

const secret = "test-webhook-secret-with-at-least-32-bytes";
const env = {
  DEPLOY_CENTER_REPO: "ltana6927/deploy-center",
  DEPLOY_DISPATCH_TOKEN: "test-dispatch-token",
  GITHUB_APP_INSTALLATION_ID: "42",
  GITHUB_WEBHOOK_SECRET: secret,
  PRODUCTION_BRANCH: "main",
  TRUSTED_OWNER: "ltana6927",
  TRUSTED_WORKFLOW_PATH: ".github/workflows/docker-build.yml",
};

const payload = {
  action: "completed",
  installation: { id: 42 },
  repository: {
    full_name: "ltana6927/railsanya-meeting",
    owner: { login: "ltana6927" },
  },
  workflow_run: {
    id: 123456789,
    repository: { full_name: "ltana6927/railsanya-meeting" },
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: "a".repeat(40),
    path: ".github/workflows/docker-build.yml",
    event: "push",
  },
};

async function signature(body, signingSecret = secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function webhookRequest(value, options = {}) {
  const body = JSON.stringify(value);
  return new Request("https://webhook.example.test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event ?? "workflow_run",
      "x-github-delivery": "00000000-0000-4000-8000-000000000000",
      "x-hub-signature-256": await signature(
        body,
        options.secret ?? secret,
      ),
    },
    body,
  });
}

test("validates a successful workflow and sends only three source fields", async () => {
  let call;
  const result = await handleRequest(
    await webhookRequest(payload),
    env,
    async (...args) => {
      call = args;
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(result.status, 204);
  assert.equal(call[0], "https://api.github.com/repos/ltana6927/deploy-center/dispatches");
  assert.deepEqual(JSON.parse(call[1].body), {
    event_type: "deploy-service",
    client_payload: {
      source_repo: "ltana6927/railsanya-meeting",
      source_sha: "a".repeat(40),
      source_run_id: "123456789",
    },
  });
});

test("rejects an invalid webhook signature without dispatching", async () => {
  let dispatched = false;
  const result = await handleRequest(
    await webhookRequest(payload, { secret: "wrong-secret" }),
    env,
    async () => {
      dispatched = true;
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(result.status, 401);
  assert.equal(dispatched, false);
});

for (const [name, change] of [
  ["failed build", { conclusion: "failure" }],
  ["wrong branch", { head_branch: "dev" }],
  ["wrong workflow", { path: ".github/workflows/other.yml" }],
  ["partial SHA", { head_sha: "abc123" }],
]) {
  test(`ignores ${name}`, async () => {
    const changed = {
      ...payload,
      workflow_run: { ...payload.workflow_run, ...change },
    };
    let dispatched = false;
    const result = await handleRequest(
      await webhookRequest(changed),
      env,
      async () => {
        dispatched = true;
        return new Response(null, { status: 204 });
      },
    );

    assert.equal(result.status, 202);
    assert.equal(dispatched, false);
  });
}

test("does not expose an upstream GitHub error body", async () => {
  const result = await handleRequest(
    await webhookRequest(payload),
    env,
    async () => new Response("sensitive upstream detail", { status: 403 }),
  );

  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { message: "dispatch failed" });
});

test("rejects incomplete tenant configuration", async () => {
  let dispatched = false;
  const result = await handleRequest(
    await webhookRequest(payload),
    { ...env, DEPLOY_CENTER_REPO: "" },
    async () => {
      dispatched = true;
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(result.status, 503);
  assert.equal(dispatched, false);
});

test("isolates events from another installation", async () => {
  let dispatched = false;
  const result = await handleRequest(
    await webhookRequest({ ...payload, installation: { id: 99 } }),
    env,
    async () => {
      dispatched = true;
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(result.status, 202);
  assert.equal(dispatched, false);
});

test("isolates repositories owned by another tenant", async () => {
  const foreign = {
    ...payload,
    repository: {
      full_name: "someone-else/railsanya-meeting",
      owner: { login: "someone-else" },
    },
    workflow_run: {
      ...payload.workflow_run,
      repository: { full_name: "someone-else/railsanya-meeting" },
    },
  };
  let dispatched = false;
  const result = await handleRequest(
    await webhookRequest(foreign),
    env,
    async () => {
      dispatched = true;
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(result.status, 202);
  assert.equal(dispatched, false);
});
