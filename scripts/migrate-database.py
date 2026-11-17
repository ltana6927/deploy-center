"""Run the verified image's migration job before mutating the API service."""

import json
import os
import pathlib
import re
import signal
import subprocess
import tempfile
import time
import uuid


def docker(*args):
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=30, check=True
    )
    return result.stdout.strip()


def migrate_database(service, image, image_id, command=docker, timeout=360,
                     clock=time.monotonic, pause=time.sleep):
    if not re.fullmatch(r"app_[a-zA-Z0-9_.-]+", service):
        raise ValueError("Invalid migration source service")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Invalid verified image identity")
    if image != image_id and not re.fullmatch(r"ghcr.io/ltana6927/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}", image):
        raise ValueError("Migration requires an immutable verified image")
    spec = json.loads(command("service", "inspect", service))[0]["Spec"]["TaskTemplate"]
    values = [entry.split("=", 1)[1] for entry in spec["ContainerSpec"].get("Env", [])
              if entry.startswith("POSTGRES_URL=")]
    if len(values) != 1 or not values[0] or any(c in values[0] for c in "\n\r\0"):
        raise ValueError("The source service must provide one POSTGRES_URL")
    swarm = json.loads(command("info", "--format", "{{json .Swarm}}"))
    node_id = swarm.get("NodeID", "")
    if (not re.fullmatch(r"[a-zA-Z0-9-]+", node_id) or
            swarm.get("LocalNodeState") != "active" or not swarm.get("ControlAvailable")):
        raise ValueError("Migration requires an active local Swarm manager")
    name = "database-migration-" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="deploy-migration-") as directory:
        env_file = pathlib.Path(directory) / "database.env"
        env_file.write_text("POSTGRES_URL=" + values[0] + "\n")
        env_file.chmod(0o600)
        args = ["service", "create", "--detach=true", "--name", name,
                "--mode", "replicated-job", "--replicas", "1", "--restart-condition", "none",
                "--constraint", "node.id==" + node_id, "--no-resolve-image", "--with-registry-auth",
                "--no-healthcheck", "--limit-cpu", "1", "--limit-memory", "256M",
                "--env-file", str(env_file), "--entrypoint", "node"]
        for network in spec.get("Networks", []):
            args.extend(["--network", network["Target"]])
        args.extend([image, "/app/.output/server/migrate-production.mjs", "/app/db-migrations"])
        try:
            command(*args)
            deadline = clock() + timeout
            while clock() < deadline:
                tasks = command("service", "ps", "--quiet", "--no-trunc", name).splitlines()
                if len(tasks) > 1:
                    raise ValueError("Migration must execute exactly one task")
                if tasks:
                    task = json.loads(command("inspect", "--type", "task", tasks[0]))[0]
                    status = task.get("Status", {})
                    state = status.get("State")
                    if state in ("failed", "rejected", "shutdown", "orphaned", "remove"):
                        raise ValueError("Migration task failed; API rollout blocked")
                    if state == "complete":
                        container = status.get("ContainerStatus", {})
                        if container.get("ExitCode") != 0 or task.get("NodeID") != node_id or not container.get("ContainerID"):
                            raise ValueError("Migration task did not finish successfully")
                        actual = command("container", "inspect", container["ContainerID"], "--format", "{{.Image}}")
                        if actual != image_id:
                            raise ValueError("Migration task used a different image")
                        return
                pause(2)
            raise TimeoutError("Migration timed out; API rollout blocked")
        finally:
            # Never print job logs or the source service's environment.
            command("service", "rm", name)


def interrupted(signum, frame):
    raise InterruptedError("Migration controller interrupted")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        migrate_database(os.environ["SWARM_SERVICE"], os.environ["ROLLOUT_IMAGE"], os.environ["IMAGE_ID"])
    except (Exception, KeyboardInterrupt):
        raise SystemExit("Database migration/verification failed; API rollout blocked.") from None
    print("Database migration and verification succeeded; API rollout may proceed.")
