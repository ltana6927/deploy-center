import { isIP } from "node:net";

const REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ALLOWED_CONFIG_KEYS = new Set([
  "version",
  "server",
  "mode",
  "image_component",
  "swarm_service",
  "healthcheck_url",
  "display_name",
]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function validateDispatch(payload, trustedOwner) {
  const sourceRepo = requiredString(payload?.source_repo, "source_repo");
  const sourceSha = requiredString(payload?.source_sha, "source_sha");
  const sourceRunId = String(payload?.source_run_id ?? "").trim();

  if (!REPOSITORY_PATTERN.test(sourceRepo)) {
    throw new Error("source_repo has an invalid format");
  }

  const [owner, repo] = sourceRepo.split("/");
  if (owner !== trustedOwner) {
    throw new Error(`repository owner ${owner} is not trusted`);
  }

  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error("source_sha must be a full lowercase commit SHA");
  }

  if (!/^\d+$/.test(sourceRunId)) {
    throw new Error("source_run_id must be numeric");
  }

  return { owner, repo, sourceRepo, sourceSha, sourceRunId };
}

export function validateWorkflowRun(run, request, options) {
  if (run?.repository?.full_name !== request.sourceRepo) {
    throw new Error("workflow run belongs to a different repository");
  }
  if (run?.head_sha !== request.sourceSha) {
    throw new Error("workflow run commit does not match source_sha");
  }
  if (run?.head_branch !== options.productionBranch) {
    throw new Error(`workflow run must target ${options.productionBranch}`);
  }
  if (run?.path !== options.workflowPath) {
    throw new Error(`workflow run must use ${options.workflowPath}`);
  }
  if (run?.status !== "completed") {
    throw new Error("workflow run has not completed");
  }
  if (!["push", "workflow_dispatch"].includes(run?.event)) {
    throw new Error(`workflow event ${run?.event ?? "unknown"} is not allowed`);
  }
  if (typeof run?.conclusion !== "string" || run.conclusion === "") {
    throw new Error("workflow run has no conclusion");
  }
}

export function validateDeployConfig(config, request, expectedServer) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("deployment config must be a YAML object");
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error(`unsupported deployment config key: ${key}`);
    }
  }

  if (config.version !== 1) {
    throw new Error("deployment config version must be 1");
  }

  const server = requiredString(config.server, "server");
  const mode = requiredString(config.mode, "mode");
  const imageComponent = requiredString(
    config.image_component,
    "image_component",
  );
  const swarmService = requiredString(config.swarm_service, "swarm_service");
  const healthcheckUrl = requiredString(
    config.healthcheck_url,
    "healthcheck_url",
  );
  const displayName =
    typeof config.display_name === "string" && config.display_name.trim() !== ""
      ? config.display_name.trim()
      : request.repo;

  if (server !== expectedServer) {
    throw new Error(`server must be ${expectedServer}`);
  }
  if (mode !== "swarm") {
    throw new Error("only swarm deployment mode is supported");
  }
  if (!COMPONENT_PATTERN.test(imageComponent)) {
    throw new Error("image_component has an invalid format");
  }
  if (!SERVICE_PATTERN.test(swarmService)) {
    throw new Error("swarm_service has an invalid format");
  }

  const servicePrefix = `app_${request.repo}`;
  if (
    swarmService !== servicePrefix &&
    !swarmService.startsWith(`${servicePrefix}-`)
  ) {
    throw new Error(`swarm_service must stay within ${servicePrefix}`);
  }

  const healthUrl = new URL(healthcheckUrl);
  if (healthUrl.protocol !== "https:") {
    throw new Error("healthcheck_url must use HTTPS");
  }
  if (healthUrl.username || healthUrl.password || healthUrl.hash) {
    throw new Error("healthcheck_url cannot contain credentials or fragments");
  }
  if (healthUrl.port && healthUrl.port !== "443") {
    throw new Error("healthcheck_url can only use the standard HTTPS port");
  }
  if (
    healthUrl.hostname === "localhost" ||
    healthUrl.hostname.endsWith(".local") ||
    isIP(healthUrl.hostname)
  ) {
    throw new Error("healthcheck_url must use a public DNS hostname");
  }

  const imageRepository = `ghcr.io/${request.sourceRepo.toLowerCase()}/${imageComponent}`;

  return {
    displayName,
    healthcheckUrl: healthUrl.toString(),
    imageComponent,
    imageRef: `${imageRepository}:${request.sourceSha}`,
    imageRepository,
    mode,
    server,
    servicePrefix,
    swarmService,
  };
}

