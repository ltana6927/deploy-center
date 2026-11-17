import importlib.util
import json
import pathlib
import stat
import unittest

spec = importlib.util.spec_from_file_location("migrations", pathlib.Path(__file__).parents[1] / "scripts/migrate-database.py")
migrations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrations)
IMAGE_ID = "sha256:" + "a" * 64
IMAGE = "ghcr.io/ltana6927/grow-up-star/tanstack-start@sha256:" + "b" * 64


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.state = "complete"
        self.exit_code = 0
        self.actual_image = IMAGE_ID
        self.environment = ["POSTGRES_URL=postgres://user:test-only-secret@database/app", "UNRELATED_SECRET=must-not-copy"]
        self.env_file = None

    def docker(self, *args):
        self.calls.append(args)
        if args[:2] == ("service", "inspect"):
            return json.dumps([{"Spec": {"TaskTemplate": {"ContainerSpec": {"Env": self.environment}, "Networks": [{"Target": "production-overlay"}]}}}])
        if args[0] == "info":
            return json.dumps({"NodeID": "node-1", "LocalNodeState": "active", "ControlAvailable": True})
        if args[:2] == ("service", "create"):
            self.env_file = pathlib.Path(args[args.index("--env-file") + 1])
            self.assertEqual(stat.S_IMODE(self.env_file.stat().st_mode), 0o600)
            self.assertEqual(self.env_file.read_text(), "POSTGRES_URL=postgres://user:test-only-secret@database/app\n")
            self.assertNotIn("test-only-secret", " ".join(args))
            self.assertIn("replicated-job", args)
            self.assertIn("node.id==node-1", args)
            self.assertIn("production-overlay", args)
            self.assertIn("--no-healthcheck", args)
            self.assertEqual(args[-3:], (IMAGE, "/app/.output/server/migrate-production.mjs", "/app/db-migrations"))
            return "job-1"
        if args[:2] == ("service", "ps"):
            return "task-1"
        if args[0] == "inspect":
            return json.dumps([{"NodeID": "node-1", "Status": {"State": self.state, "ContainerStatus": {"ExitCode": self.exit_code, "ContainerID": "container-1"}}}])
        if args[0] == "container":
            return self.actual_image
        if args[:2] == ("service", "rm"):
            return "removed"
        self.fail("Unexpected Docker operation: " + str(args))

    def run_migration(self, **options):
        return migrations.migrate_database("app_grow-up-star-api", IMAGE, IMAGE_ID, command=self.docker, pause=lambda seconds: None, **options)

    def assert_cleaned(self):
        self.assertEqual(self.calls[-1][:2], ("service", "rm"))
        self.assertFalse(self.env_file.exists())
        self.assertFalse(any(call[:2] == ("service", "update") for call in self.calls))

    def test_only_successful_verified_job_can_pass_and_all_temporary_state_is_cleaned(self):
        self.run_migration()
        self.assert_cleaned()

    def test_failed_or_nonzero_tasks_block_rollout_and_are_cleaned(self):
        for state, code in [("failed", 1), ("rejected", 0), ("shutdown", 0), ("complete", 7)]:
            with self.subTest(state=state, code=code):
                self.state, self.exit_code = state, code
                with self.assertRaises(ValueError):
                    self.run_migration()
                self.assert_cleaned()

    def test_a_different_task_image_blocks_rollout(self):
        self.actual_image = "sha256:" + "c" * 64
        with self.assertRaisesRegex(ValueError, "different image"):
            self.run_migration()
        self.assert_cleaned()

    def test_timeout_blocks_rollout_and_removes_the_job(self):
        with self.assertRaises(TimeoutError):
            self.run_migration(timeout=0)
        self.assert_cleaned()

    def test_missing_duplicate_or_multiline_database_settings_fail_before_creating_a_job(self):
        for environment in [[], ["POSTGRES_URL="], ["POSTGRES_URL=x", "POSTGRES_URL=y"], ["POSTGRES_URL=secret\ninjected=x"]]:
            with self.subTest(environment=environment):
                self.calls = []
                self.environment = environment
                with self.assertRaises(ValueError):
                    self.run_migration()
                self.assertFalse(any(call[:2] == ("service", "create") for call in self.calls))


if __name__ == "__main__":
    unittest.main()
