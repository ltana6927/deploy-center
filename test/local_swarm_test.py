import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location(
    "local_swarm", pathlib.Path(__file__).parents[1] / "scripts/verify-local-swarm.py"
)
local_swarm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_swarm)

IMAGE = "sha256:" + "c" * 64


class LocalSwarmTest(unittest.TestCase):
    def setUp(self):
        self.swarm = {"NodeID": "node-1", "LocalNodeState": "active", "ControlAvailable": True}
        self.nodes = ["node-1"]
        self.node = {"Status": {"State": "ready"}, "Spec": {"Availability": "active"}}
        self.tasks = ["task-1"]
        self.task = {"NodeID": "node-1", "Status": {"State": "running", "ContainerStatus": {"ContainerID": "container-1"}}}
        self.image = IMAGE

    def docker(self, *args):
        if args[0] == "info":
            return json.dumps(self.swarm)
        if args[:2] == ("node", "ls"):
            return "\n".join(self.nodes)
        if args[:2] == ("node", "inspect"):
            return json.dumps(self.node)
        if args[:2] == ("service", "ps"):
            return "\n".join(self.tasks)
        if args[:3] == ("inspect", "--type", "task"):
            return json.dumps(self.task)
        if args[:2] == ("container", "inspect"):
            return self.image
        self.fail(f"Unexpected command: {args}")

    def test_accepts_only_the_current_active_manager(self):
        self.assertEqual(local_swarm.verify_node(self.docker), "node-1")
        for change in [{"NodeID": ""}, {"LocalNodeState": "inactive"}, {"ControlAvailable": False}]:
            with self.subTest(change=change):
                original = self.swarm.copy()
                self.swarm.update(change)
                with self.assertRaisesRegex(ValueError, "active Swarm manager"):
                    local_swarm.verify_node(self.docker)
                self.swarm = original

    def test_rejects_other_nodes_even_when_one_is_offline(self):
        for nodes in [[], ["node-2"], ["node-1", "node-2"]]:
            with self.subTest(nodes=nodes):
                self.nodes = nodes
                with self.assertRaisesRegex(ValueError, "single-node Swarm"):
                    local_swarm.verify_node(self.docker)

    def test_rejects_drained_or_unready_nodes(self):
        for change in [{"Status": {"State": "down"}}, {"Spec": {"Availability": "drain"}}]:
            with self.subTest(change=change):
                original = self.node.copy()
                self.node.update(change)
                with self.assertRaisesRegex(ValueError, "ready and active"):
                    local_swarm.verify_node(self.docker)
                self.node = original

    def test_accepts_the_exact_image_on_every_running_task(self):
        self.tasks = ["task-1", "task-2"]
        local_swarm.verify_tasks("app_example-api", IMAGE, self.docker)

    def test_rejects_missing_pending_or_foreign_tasks(self):
        self.tasks = []
        with self.assertRaisesRegex(ValueError, "no running tasks"):
            local_swarm.verify_tasks("app_example-api", IMAGE, self.docker)
        self.tasks = ["task-1"]
        for change in [{"NodeID": "node-2"}, {"Status": {"State": "starting"}}, {"Status": {"State": "running"}}]:
            with self.subTest(change=change):
                original = self.task.copy()
                self.task.update(change)
                with self.assertRaisesRegex(ValueError, "verified local node"):
                    local_swarm.verify_tasks("app_example-api", IMAGE, self.docker)
                self.task = original

    def test_rejects_an_unexpected_or_malformed_image_id(self):
        self.image = "sha256:" + "d" * 64
        with self.assertRaisesRegex(ValueError, "differs from the authenticated archive"):
            local_swarm.verify_tasks("app_example-api", IMAGE, self.docker)
        with self.assertRaisesRegex(ValueError, "Invalid authenticated image ID"):
            local_swarm.verify_tasks("app_example-api", "latest", self.docker)


if __name__ == "__main__":
    unittest.main()
