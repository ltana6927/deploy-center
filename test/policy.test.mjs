import test from "node:test";
import assert from "node:assert/strict";
import {
  validateDeployConfig,
  validateDispatch,
  validateWorkflowRun,
  validateImageArchive,
} from "../scripts/policy.mjs";

test("image archives are bound to the successful source run and commit", () => {
  const artifact = {
    id: 456,
    name: `production-image-${"a".repeat(40)}`,
    expired: false,
    size_in_bytes: 100,
    digest: `sha256:${"b".repeat(64)}`,
    workflow_run: { id: 123, head_sha: "a".repeat(40) },
  };
  assert.deepEqual(validateImageArchive([artifact], request), {
    id: "456",
    digest: artifact.digest,
    size: "100",
  });
  assert.equal(validateImageArchive([], request), null);
  for (const override of [
    { expired: true },
    { id: "456" },
    { digest: "invalid" },
    { size_in_bytes: 2 ** 31 },
    { workflow_run: { id: 999, head_sha: request.sourceSha } },
    { workflow_run: { id: 123, head_sha: "c".repeat(40) } },
  ]) {
    assert.throws(
      () => validateImageArchive([{ ...artifact, ...override }], request),
      /invalid|another build/,
    );
  }
  assert.throws(
    () => validateImageArchive([artifact, artifact], request),
    /ambiguous/,
  );
});

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

test("rejects extra dispatch fields", () => {
  assert.throws(
    () =>
      validateDispatch(
        {
          source_repo: request.sourceRepo,
          source_sha: request.sourceSha,
          source_run_id: request.sourceRunId,
          image: "ghcr.io/attacker/image:latest",
        },
        "ltana6927",
      ),
    /unsupported client_payload key/,
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

test("rejects a failed trusted build", () => {
  assert.throws(
    () =>
      validateWorkflowRun(
        {
          repository: { full_name: request.sourceRepo },
          head_sha: request.sourceSha,
          head_branch: "main",
          path: ".github/workflows/docker-build.yml",
          status: "completed",
          conclusion: "failure",
          event: "push",
        },
        request,
        {
          productionBranch: "main",
          workflowPath: ".github/workflows/docker-build.yml",
        },
      ),
    /did not succeed/,
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
