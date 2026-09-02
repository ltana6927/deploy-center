const MAX_BODY_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const RUN_ID_PATTERN = /^\d+$/;
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const encoder = new TextEncoder();

function response(status, message) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bytesFromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function verifySignature(body, signatureHeader, secret) {
  const match = SIGNATURE_PATTERN.exec(signatureHeader ?? "");
  if (!match || !secret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, bytesFromHex(match[1]), body);
}

function deploymentRequest(payload, env) {
  if (payload?.action !== "completed") return null;

  const repository = payload.repository;
  const run = payload.workflow_run;
  const expectedOwner = env.TRUSTED_OWNER;
  const expectedWorkflowPath = env.TRUSTED_WORKFLOW_PATH;
  const expectedBranch = env.PRODUCTION_BRANCH;

  if (
    !repository ||
    repository.owner?.login !== expectedOwner ||
    typeof repository.full_name !== "string" ||
    !repository.full_name.startsWith(`${expectedOwner}/`) ||
    !run ||
    run.repository?.full_name !== repository.full_name ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_branch !== expectedBranch ||
    run.path !== expectedWorkflowPath ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    !SHA_PATTERN.test(run.head_sha ?? "") ||
    !RUN_ID_PATTERN.test(String(run.id ?? ""))
  ) {
    return null;
  }

  const expectedInstallationId = String(env.GITHUB_APP_INSTALLATION_ID ?? "");
  if (
    expectedInstallationId &&
    String(payload.installation?.id ?? "") !== expectedInstallationId
  ) {
    return null;
  }

  return {
    source_repo: repository.full_name,
    source_sha: run.head_sha,
    source_run_id: String(run.id),
  };
}

function invalidConfigurationKeys(env) {
  const checks = {
    TRUSTED_OWNER: OWNER_PATTERN.test(env.TRUSTED_OWNER ?? ""),
    DEPLOY_CENTER_REPO:
      REPOSITORY_PATTERN.test(env.DEPLOY_CENTER_REPO ?? "") &&
      env.DEPLOY_CENTER_REPO?.startsWith(`${env.TRUSTED_OWNER}/`),
    PRODUCTION_BRANCH:
      typeof env.PRODUCTION_BRANCH === "string" &&
      env.PRODUCTION_BRANCH.length > 0,
    TRUSTED_WORKFLOW_PATH:
      typeof env.TRUSTED_WORKFLOW_PATH === "string" &&
      env.TRUSTED_WORKFLOW_PATH.startsWith(".github/workflows/"),
    GITHUB_APP_INSTALLATION_ID: /^\d+$/.test(
      String(env.GITHUB_APP_INSTALLATION_ID ?? ""),
    ),
    GITHUB_WEBHOOK_SECRET:
      typeof env.GITHUB_WEBHOOK_SECRET === "string" &&
      env.GITHUB_WEBHOOK_SECRET.length >= 32,
    DEPLOY_DISPATCH_TOKEN:
      typeof env.DEPLOY_DISPATCH_TOKEN === "string" &&
      env.DEPLOY_DISPATCH_TOKEN.length > 0,
  };

  return Object.entries(checks)
    .filter(([, valid]) => !valid)
    .map(([key]) => key);
}

export async function handleRequest(request, env, dispatchFetch = fetch) {
  if (request.method !== "POST") {
    return response(405, "method not allowed");
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return response(413, "payload too large");
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return response(413, "payload too large");
  }

  const signatureValid = await verifySignature(
    body,
    request.headers.get("x-hub-signature-256"),
    env.GITHUB_WEBHOOK_SECRET,
  );
  if (!signatureValid) {
    return response(401, "invalid signature");
  }

  const event = request.headers.get("x-github-event");
  if (event === "ping") return response(200, "pong");
  if (event !== "workflow_run") return response(202, "event ignored");

  const invalidKeys = invalidConfigurationKeys(env);
  if (invalidKeys.length > 0) {
    console.error("Receiver configuration is invalid", { invalidKeys });
    return response(503, "receiver is not configured");
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return response(400, "invalid JSON");
  }

  const deployment = deploymentRequest(payload, env);
  if (!deployment) return response(202, "workflow run ignored");

  const upstream = await dispatchFetch(
    `https://api.github.com/repos/${env.DEPLOY_CENTER_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.DEPLOY_DISPATCH_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "deploy-center-webhook",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event_type: "deploy-service",
        client_payload: deployment,
      }),
    },
  );

  if (upstream.status !== 204) {
    return response(502, "dispatch failed");
  }
  return new Response(null, { status: 204 });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
