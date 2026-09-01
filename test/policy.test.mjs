import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDeployConfig,
  validateDispatch,
  validateWorkflowRun,
} from "../scripts/policy.mjs";

const request = {
  owner: "ltana6927",
  repo: "railsanya-meeting",
  sourceRepo: "ltana6927/railsanya-meeting",
  sourceSha: "a".repeat(40),
  sourceRunId: "123",
};

test("accepts an owner-scoped dispatch", () => {
  assert.deepEqual(
    validateDispatch(
      {
        source_repo: request.sourceRepo,
        source_sha: request.sourceSha,
        source_run_id: request.sourceRunId,
      },
      "ltana6927",
    ),
    request,
  );
});

test("rejects a repository owned by another user", () => {
  assert.throws(
    () =>
      validateDispatch(
        {
          source_repo: "attacker/railsanya-meeting",
          source_sha: request.sourceSha,
          source_run_id: request.sourceRunId,
        },
        "ltana6927",
      ),
    /not trusted/,
  );
});

test("validates the completed trusted build", () => {
  assert.doesNotThrow(() =>
    validateWorkflowRun(
      {
        repository: { full_name: request.sourceRepo },
        head_sha: request.sourceSha,
        head_branch: "main",
        path: ".github/workflows/docker-build.yml",
        status: "completed",
        conclusion: "success",
        event: "push",
      },
      request,
      {
        productionBranch: "main",
        workflowPath: ".github/workflows/docker-build.yml",
      },
    ),
  );
});

test("derives the image and restricts the Swarm namespace", () => {
  const result = validateDeployConfig(
    {
      version: 1,
      server: "monadao-prod",
      mode: "swarm",
      image_component: "nextjs",
      swarm_service: "app_railsanya-meeting-api",
      healthcheck_url: "https://www.railsanya.com/api/health",
      display_name: "RailSanya 2027",
    },
    request,
    "monadao-prod",
  );

  assert.equal(
    result.imageRef,
    `ghcr.io/ltana6927/railsanya-meeting/nextjs:${request.sourceSha}`,
  );
  assert.equal(result.swarmService, "app_railsanya-meeting-api");
});

test("rejects another repository's Swarm service", () => {
  assert.throws(
    () =>
      validateDeployConfig(
        {
          version: 1,
          server: "monadao-prod",
          mode: "swarm",
          image_component: "nextjs",
          swarm_service: "app_another-service-api",
          healthcheck_url: "https://www.railsanya.com/api/health",
        },
        request,
        "monadao-prod",
      ),
    /must stay within/,
  );
});

test("rejects arbitrary commands and private health targets", () => {
  assert.throws(
    () =>
      validateDeployConfig(
        {
          version: 1,
          server: "monadao-prod",
          mode: "swarm",
          image_component: "nextjs",
          swarm_service: "app_railsanya-meeting-api",
          healthcheck_url: "https://127.0.0.1/admin",
          command: "docker rm -f important-service",
        },
        request,
        "monadao-prod",
      ),
    /unsupported deployment config key/,
  );
});

