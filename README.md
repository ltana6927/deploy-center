# Deploy Center

Centralized Docker Swarm deployments for repositories owned by `ltana6927`.
Business repositories build immutable images on GitHub-hosted runners. This
repository validates the completed build and performs the production rollout
on a server-side self-hosted runner.

## Trust model

Deploy Center accepts only `repository_dispatch` events that pass all checks:

- The source repository owner is exactly `ltana6927`.
- The referenced GitHub Actions run exists, is completed, and belongs to the
  supplied repository and commit.
- The build ran from `main` using `.github/workflows/docker-build.yml`.
- Deployment configuration is read from `.github/deploy.yml` at that exact
  commit. Configuration supplied directly in the dispatch payload is ignored.
- The image path is derived as `ghcr.io/<owner>/<repo>/<component>:<sha>`.
- The Swarm service must be named `app_<repo>` or start with `app_<repo>-`.
- No repository-provided shell command is accepted or executed.

The repository is public, but the production deployment workflow has no
`pull_request` trigger. Pull-request CI runs only on GitHub-hosted runners,
without deployment credentials. Only accounts holding write access can manually
change or trigger deployments, and only a token with access to this repository
can send a dispatch event.

## Service configuration

Each business repository owns one flat configuration file:

```yaml
# .github/deploy.yml
version: 1
server: monadao-prod
mode: swarm
image_component: nextjs
swarm_service: app_railsanya-meeting-api
healthcheck_url: https://www.railsanya.com/api/health
display_name: RailSanya 2027
```

Adding a service does not require editing Deploy Center. The repository name
determines the allowed image and Swarm service namespace.

## Source workflow

The preferred notification path is the signed GitHub App `workflow_run`
webhook described in [`docs/github-app-webhook.md`](docs/github-app-webhook.md).
With the App installed for all repositories, a business repository needs no
cross-repository token and no request workflow.

The receiver is open-source and configuration-driven, but each deployment is
single-tenant. Repository owner, Deploy Center repository, GitHub App
installation, trusted branch, workflow path, and secrets are isolated per
Worker instance.

The repository-local dispatch flow below remains available during migration:

The source repository needs:

1. A build workflow at `.github/workflows/docker-build.yml` that pushes both
   the commit SHA tag and `latest`.
2. A `.github/workflows/request-deploy.yml` workflow triggered by successful
   completion of that build. Copy [`examples/request-deploy.yml`](examples/request-deploy.yml)
   and replace its reusable-workflow ref with an immutable Deploy Center commit
   SHA. The dispatch implementation is shared; the source repository sends only
   `source_repo`, `source_sha`, and `source_run_id`.
3. A `DEPLOY_CENTER_TOKEN` secret with permission to send repository dispatch
   events to `ltana6927/deploy-center`.

Use a fine-grained token limited to the Deploy Center repository with
`Contents: Read and write`. Do not use a broad personal token long term.

No Deploy Center workflow or `SOURCE_READ_TOKEN` edit is needed when onboarding
another repository. Add its `.github/deploy.yml`, add or reuse
`request-deploy.yml`, and set its repository-local `DEPLOY_CENTER_TOKEN`. The
trusted build must keep the conventional path
`.github/workflows/docker-build.yml`, build from `main`, and publish the full
lowercase commit SHA tag.

## Deploy Center secrets

- `SOURCE_READ_TOKEN`: fine-grained `Actions: Read-only` and `Contents:
  Read-only` access to repositories owned by `ltana6927`. It is configured for
  all repositories so new private sources require no token update. This trades
  repository isolation for maintenance-free onboarding; see the security guide.
- `FEISHU_WEBHOOK`: Feishu bot webhook used for build and deployment results.

See [`docs/fine-grained-pat.md`](docs/fine-grained-pat.md) for the exact GitHub
UI selections and history-safe interactive `gh secret set` commands.

## Runner

Register one official GitHub Actions runner to this repository and label it:

```text
self-hosted, Linux, X64, monadao-prod, swarm
```

The runner must be able to run Docker Swarm commands. The workflow is serialized
per source repository and globally per production server. The registry path
pulls the full-SHA tag, verifies its OCI revision label, and updates the service
by immutable registry digest with `start-first` order. Webhook redeliveries skip
an already-selected immutable image while still running verification and the
health check.

For builds that publish `production-image-<sha>` in the trusted Docker build
run, a registry pull is bounded to three minutes. A failure automatically
downloads that run's artifact over the separate artifact-storage route, with
eight concurrent HTTP ranges, each with up to eight resumable attempts. Range
responses must match the expected offset and artifact size; timeouts keep only
valid partial bytes, and expired storage URLs are refreshed without forwarding
the GitHub credential. No workstation or SSH upload
is needed. The API artifact digest, exported image checksum, source revision,
repository, image ID, and recorded registry digest must agree before rollout. Archive
downloads use the existing source-read token and private temporary files that
are removed on exit. The runner needs Python 3 and curl with range support.

After an archive is authenticated and loaded, recovery performs no further
registry pull or `RepoDigests` lookup. `docker load` does not restore registry
digests, so the rollout uses the authenticated immutable Docker image ID and
`--no-resolve-image`. This path requires an active, ready, single-node Swarm
whose manager is the node holding that image. Multi-node clusters fail before
rollout; distributing a verified image to every eligible node is not implemented.
The node and cached identity are rechecked immediately before update. Running
task containers must use that exact image ID before health verification can
succeed. Registry-backed deployments retain their digest and authentication path.

An authorized `verify-image-archive` dispatch accepts the same three validated
source fields and exercises the archive path without a Swarm rollout. Use it
to check the real download, checksums, image identity and local-node boundary
independently of GHCR availability.

Older builds without an archive retain two attempts, each bounded to 20 minutes with a 30-second
termination grace period. A failed first attempt waits 15 seconds before
retrying; Docker reuses completed layers. The deployment job allows 65 minutes
so a slow or interrupted registry download does not consume the rollout and
health-check budget. Exhausted downloads fail before the service is updated;
every successful download still requires matching revision and digest checks.

Application logs are never copied into GitHub Actions output. When a health
check fails, inspect them through the server's private logging system.

Private GHCR authentication is provisioned once on the server in the runner
user's `~/.docker/config.json`. Deploy Center does not store a long-lived GHCR
token in GitHub Actions secrets.

## CI

Run `npm ci`, `npm test`, and `npm run test:swarm` before publishing changes.
The last command needs Docker plus cached `busybox:1.36` and the pinned Docker
25 DinD image from `.github/workflows/ci.yml`. It creates a separate privileged
test daemon on an internal network, with no host socket, published port, or
internet route. Its containers, anonymous volume and network are removed on exit;
the existing host Swarm is never initialized or changed.

CI runs the full Node/Python suite and the real offline Swarm suite on
GitHub-hosted runners. The latter executes the workflow's actual image and
rollout scripts with a valid archive while every registry pull fails. It checks
rollout by immutable image ID, live task identity, redelivery idempotence, and
verification-only/tampered-artifact behavior. No production service, model call,
webhook credential or Feishu test message is used.
