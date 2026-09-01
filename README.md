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

The repository is public, but its workflow has no `pull_request` trigger. Only
accounts holding write access can manually change or trigger its workflow, and
only a token with access to this repository can send a dispatch event.

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

The source repository needs:

1. A build workflow at `.github/workflows/docker-build.yml` that pushes both
   the commit SHA tag and `latest`.
2. A `.github/workflows/request-deploy.yml` workflow triggered by completion
   of that build.
3. A `DEPLOY_CENTER_TOKEN` secret with permission to send repository dispatch
   events to `ltana6927/deploy-center`.

Use a fine-grained token limited to the Deploy Center repository with
`Contents: Read and write`. Do not use a broad personal token long term.

## Deploy Center secrets

- `SOURCE_READ_TOKEN`: fine-grained read access to source repository Contents
  and Actions metadata. Required for private source repositories.
- `GHCR_PULL_TOKEN`: read access to the source container packages.
- `FEISHU_WEBHOOK`: Feishu bot webhook used for build and deployment results.

## Runner

Register one official GitHub Actions runner to this repository and label it:

```text
self-hosted, Linux, X64, monadao-prod, swarm
```

The runner must be able to run Docker Swarm commands. The workflow is serialized
per source repository and pulls the immutable SHA-tagged image before updating
the service with `start-first` order.

