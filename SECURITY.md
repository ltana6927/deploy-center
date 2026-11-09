# Security Policy

Do not report vulnerabilities through a public issue. Contact the repository
owner privately.

The production runner is intentionally reachable only through the trusted
deployment workflow. Pull requests never execute on the self-hosted runner.
Deployment requests are rejected unless their repository owner, completed
build, commit, branch, workflow path, image namespace, and Swarm service
namespace all pass validation.

Long-lived deployment credentials must be fine-grained, expiring PATs with only
the permissions required by their role. Never initialize repository secrets
from `gh auth token`, pass a token as a command-line argument, or commit it to a
file. Follow
[`docs/fine-grained-pat.md`](docs/fine-grained-pat.md) for creation and rotation.

The dispatch token remains restricted to only `deploy-center`. The source-read
token deliberately covers all repositories owned by `ltana6927`, but grants
only Actions and Contents read access. This exception removes per-repository
credential maintenance and must be reconsidered if unrelated sensitive private
repositories are added to the account.

The public workflow must never print application or container logs. Production
diagnostics remain on the server or in a private logging system. Images are
checked against the verified source revision and deployed by immutable registry
digest. Authenticated archive recovery uses the exact Docker image ID without
another registry lookup, only on a verified single-node Swarm. The local node
and cached identity are checked again before rollout, and every running task's
container must match that image ID afterwards. A mutable tag cannot select a
different artifact in either path. Archive checksums, source binding and revision
checks remain mandatory even when an image is already cached.
