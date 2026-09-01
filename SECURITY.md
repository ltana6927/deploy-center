# Security Policy

Do not report vulnerabilities through a public issue. Contact the repository
owner privately.

The production runner is intentionally reachable only through the trusted
deployment workflow. Pull requests never execute on the self-hosted runner.
Deployment requests are rejected unless their repository owner, completed
build, commit, branch, workflow path, image namespace, and Swarm service
namespace all pass validation.

