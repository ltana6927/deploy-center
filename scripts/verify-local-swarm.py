"""Keep archive rollouts on the node that holds the authenticated image."""

import argparse
import json
import re
import subprocess


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def verify_node(command=docker):
    swarm = json.loads(command("info", "--format", '{"NodeID":{{json .Swarm.NodeID}},"LocalNodeState":{{json .Swarm.LocalNodeState}},"ControlAvailable":{{json .Swarm.ControlAvailable}}}'))
    node_id = swarm.get("NodeID")
    if not node_id or swarm.get("LocalNodeState") != "active" or not swarm.get("ControlAvailable"):
        raise ValueError("Archive rollout requires an active Swarm manager")
    nodes = command("node", "ls", "--quiet").splitlines()
    if nodes != [node_id]:
        raise ValueError("Archive rollout requires a single-node Swarm with the image loaded locally")
    node = json.loads(command("node", "inspect", node_id, "--format", '{"Status":{"State":{{json .Status.State}}},"Spec":{"Availability":{{json .Spec.Availability}}}}'))
    if node.get("Status", {}).get("State") != "ready" or node.get("Spec", {}).get("Availability") != "active":
        raise ValueError("Archive rollout requires the local node to be ready and active")
    return node_id


def verify_tasks(service, image_id, command=docker):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise ValueError("Invalid authenticated image ID")
    node_id = verify_node(command)
    tasks = command("service", "ps", "--filter", "desired-state=running", "--quiet", "--no-trunc", service).splitlines()
    if not tasks:
        raise ValueError("Recovered service has no running tasks")
    for task_id in tasks:
        task = json.loads(command("inspect", "--type", "task", task_id, "--format", '{"NodeID":{{json .NodeID}},"Status":{{json .Status}}}'))
        status = task.get("Status", {})
        container_id = status.get("ContainerStatus", {}).get("ContainerID")
        if task.get("NodeID") != node_id or status.get("State") != "running" or not container_id:
            raise ValueError("Recovered service task is not running on the verified local node")
        actual = command("container", "inspect", container_id, "--format", "{{.Image}}")
        if actual != image_id:
            raise ValueError("Running task image differs from the authenticated archive")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["node", "tasks"])
    parser.add_argument("--service")
    parser.add_argument("--image-id")
    args = parser.parse_args()
    if args.mode == "node":
        verify_node()
    else:
        if not args.service or not args.image_id:
            parser.error("tasks requires --service and --image-id")
        verify_tasks(args.service, args.image_id)
    print("Verified local Swarm archive rollout boundary")
