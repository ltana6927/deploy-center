import { appendFile, readFile } from "node:fs/promises";
import YAML from "yaml";
import {
  validateDeployConfig,
  validateDispatch,
  validateWorkflowRun,
} from "./policy.mjs";

const eventPath = process.env.GITHUB_EVENT_PATH;
const outputPath = process.env.GITHUB_OUTPUT;
const token = process.env.SOURCE_READ_TOKEN;
const trustedOwner = process.env.TRUSTED_OWNER ?? "ltana6927";
const expectedServer = process.env.EXPECTED_SERVER ?? "monadao-prod";
const productionBranch = process.env.PRODUCTION_BRANCH ?? "main";
const workflowPath =
  process.env.TRUSTED_WORKFLOW_PATH ?? ".github/workflows/docker-build.yml";
const configPath = process.env.DEPLOY_CONFIG_PATH ?? ".github/deploy.yml";

if (!eventPath || !outputPath || !token) {
  throw new Error(
    "GITHUB_EVENT_PATH, GITHUB_OUTPUT, and SOURCE_READ_TOKEN are required",
  );
}

const event = JSON.parse(await readFile(eventPath, "utf8"));
const request = validateDispatch(event.client_payload, trustedOwner);

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ltana6927-deploy-center",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned ${response.status}`);
  }
  return response.json();
}

const run = await github(
  `/repos/${request.sourceRepo}/actions/runs/${request.sourceRunId}`,
);
validateWorkflowRun(run, request, { productionBranch, workflowPath });

const encodedConfigPath = configPath
  .split("/")
  .map(encodeURIComponent)
  .join("/");
const file = await github(
  `/repos/${request.sourceRepo}/contents/${encodedConfigPath}?ref=${request.sourceSha}`,
);

if (file.type !== "file" || file.encoding !== "base64") {
  throw new Error(`${configPath} is not a base64-encoded file`);
}

const config = YAML.parse(Buffer.from(file.content, "base64").toString("utf8"));
const deploy = validateDeployConfig(config, request, expectedServer);
const outputs = {
  build_conclusion: run.conclusion,
  display_name: deploy.displayName,
  healthcheck_url: deploy.healthcheckUrl,
  image_ref: deploy.imageRef,
  service_prefix: deploy.servicePrefix,
  source_repo: request.sourceRepo,
  source_run_url: run.html_url,
  source_sha: request.sourceSha,
  swarm_service: deploy.swarmService,
};

for (const [key, value] of Object.entries(outputs)) {
  await appendFile(outputPath, `${key}=${value}\n`, "utf8");
}

console.log(
  `Validated ${request.sourceRepo}@${request.sourceSha} for ${deploy.swarmService}`,
);

