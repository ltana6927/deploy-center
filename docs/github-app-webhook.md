# GitHub App webhook notifications

This is the preferred notification path for repositories owned by `ltana6927`.
GitHub sends a signed `workflow_run` webhook to a Cloudflare Worker, which
forwards only `source_repo`, `source_sha`, and `source_run_id` to Deploy Center.
Business repositories do not store cross-repository credentials.

Keep the existing `request-deploy.yml` and repository secret until the webhook
path has completed one production deployment. This gives a safe rollback path.

## Credential lifecycle

- Keep `SOURCE_READ_TOKEN`. Deploy Center uses it to re-fetch and verify the
  private source run and `.github/deploy.yml`.
- Keep the existing `deploy-dispatch` fine-grained PAT during this migration.
  Move its value to the Worker secret `DEPLOY_DISPATCH_TOKEN`; do not create a
  PAT per business repository.
- Create one independent high-entropy `GITHUB_WEBHOOK_SECRET`. Store the same
  value in the GitHub App webhook configuration and the Worker secret. This is
  a signing secret, not a GitHub access token.
- Never pass any of these values as command-line arguments or commit them.

## Deploy the receiver

Authenticate Wrangler using its browser login, then deploy once to obtain the
`workers.dev` URL:

```bash
npm install
npx wrangler login
npm run deploy:webhook
```

Set secrets only through Wrangler's hidden interactive prompts:

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put DEPLOY_DISPATCH_TOKEN
```

Do not use shell variables, command arguments, `.env`, or `.dev.vars` for
production secrets.

## Create the GitHub App

In **Settings → Developer settings → GitHub Apps → New GitHub App**:

- GitHub App name: a unique name such as `ltana-deploy-notifier`.
- Homepage URL: the Deploy Center repository URL.
- Webhook: Active.
- Webhook URL: the deployed Worker URL.
- Webhook secret: the same value entered for `GITHUB_WEBHOOK_SECRET`.
- Repository permissions: **Actions: Read-only**; leave other configurable
  permissions at **No access**.
- Subscribe to events: **Workflow run**.
- Where can this GitHub App be installed: **Only on this account**.

Install it for `ltana6927` with **All repositories**. Record the numeric
installation ID from the installation URL and configure it as a non-secret
Worker variable before the final deployment:

```bash
npx wrangler deploy --var GITHUB_APP_INSTALLATION_ID:12345678
```

The receiver verifies the HMAC signature before parsing the event. It accepts
only successful, completed `main` runs from
`.github/workflows/docker-build.yml`, and Deploy Center independently repeats
all source and configuration validation.

## Cut over a business repository

After a webhook-triggered deployment succeeds:

1. Delete `.github/workflows/request-deploy.yml` from the business repository.
2. Delete its repository Actions secret named `DEPLOY_CENTER_TOKEN`.
3. Keep `.github/workflows/docker-build.yml` and `.github/deploy.yml`.

Do not delete the `SOURCE_READ_TOKEN` or `deploy-dispatch` PAT from GitHub token
settings while they remain in use by Deploy Center and the Worker.
