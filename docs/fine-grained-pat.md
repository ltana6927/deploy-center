# Fine-grained PAT setup

Never copy `gh auth token` into repository secrets. Create two independent,
expiring fine-grained personal access tokens in the GitHub web UI. Do not put a
token on a command line, in a file, in an environment variable, or in shell
history.

GitHub path: **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**.

## Business repository token

Create one token for `DEPLOY_CENTER_TOKEN`:

- Token name: a purpose-specific name such as `railsanya-deploy-dispatch`.
- Expiration: the shortest operationally practical period; record a rotation
  reminder before expiry.
- Resource owner: `ltana6927`.
- Repository access: **Only select repositories**.
- Selected repositories: only `ltana6927/deploy-center`.
- Repository permissions: **Contents: Read and write**.
- Leave every other configurable repository, organization, and account
  permission at **No access**. GitHub adds Metadata read access automatically.

After generating the token, keep the page open and immediately run:

```bash
./scripts/set-pat-secret.sh deploy-center-token ltana6927/railsanya-meeting
```

Paste the token only into the GitHub CLI prompt. The script does not accept a
token argument and refuses redirected standard input.

## Deploy Center source-read token

Create a separate token for `SOURCE_READ_TOKEN`. This deployment uses an
account-wide read-only token so current and future business repositories do not
require token maintenance:

- Token name: a purpose-specific name such as `deploy-center-source-read`.
- Expiration: the shortest operationally practical period; record a rotation
  reminder before expiry.
- Resource owner: `ltana6927`.
- Repository access: **All repositories**. This includes current and future
  repositories owned by `ltana6927`.
- Repository permissions: **Actions: Read-only** and **Contents: Read-only**.
- Leave every other configurable repository, organization, and account
  permission at **No access**. GitHub adds Metadata read access automatically.

After generating the token, keep the page open and immediately run:

```bash
./scripts/set-pat-secret.sh source-read-token
```

Paste the token only into the GitHub CLI prompt.

> This avoids per-repository token updates, but `SOURCE_READ_TOKEN` can read the
> contents and Actions metadata of every private repository owned by
> `ltana6927`. It cannot write to them. Deploy Center additionally validates the
> owner, workflow path, branch, full SHA, successful run, configuration, image
> namespace, and Swarm service namespace. Use **Only select repositories**
> instead if repository isolation becomes more important than automatic
> onboarding.

## Rotation and verification

Updating a repository secret is atomic. After both new values are set, trigger
one Docker Build on `main` and confirm that Docker Build, Request Production
Deploy, and Deploy Service all succeed. Then revoke the two superseded OAuth
tokens or fine-grained PATs in GitHub settings. Secret values cannot be read
back with `gh`; only secret names and update times should be inspected.
