import unittest
import tempfile
import json
from types import SimpleNamespace
from pathlib import Path
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from zaovra_harbor import Zaovra

class AttachTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_and_cleanup_failures_preserve_original_and_persist_context_first(self):
        for cleanup in ("transport", "nonzero", "success"):
            with self.subTest(cleanup=cleanup), tempfile.TemporaryDirectory() as directory:
                calls = []
                original = OSError("original run transport unavailable")
                class Environment:
                    async def exec(self, command, **kwargs):
                        calls.append(command)
                        if " run " in command:
                            raise original
                        saved = json.loads((Path(directory) / "context.json").read_text(encoding="utf-8"))
                        self_context = saved["metadata"]
                        assert self_context["complete"] is False and self_context["usage_unknown"] is True
                        assert self_context["error"] == str(original) and self_context["cleanup_status"] == "pending"
                        if cleanup == "transport":
                            raise ConnectionError("cleanup transport unavailable")
                        return SimpleNamespace(return_code=1 if cleanup == "nonzero" else 0, stdout="", stderr="")
                agent = Zaovra(logs_dir=Path(directory), attach_backend=True)
                agent.backend = {"pid": 123, "start": "456", "url": "http://127.0.0.1:4321"}
                context = AgentContext()
                with self.assertRaises(OSError) as raised:
                    await agent.run("Generic task", Environment(), context)
                self.assertIs(raised.exception, original)
                saved = json.loads((Path(directory) / "context.json").read_text(encoding="utf-8"))["metadata"]
                self.assertEqual(saved, context.metadata)
                self.assertEqual(saved["error_type"], "OSError")
                self.assertFalse(saved["complete"])
                self.assertTrue(saved["usage_unknown"])
                self.assertEqual(len(calls), 2)
                if cleanup == "success":
                    self.assertEqual(saved["cleanup_status"], "closed")
                    self.assertIsNone(agent.backend)
                else:
                    self.assertEqual(saved["cleanup_status"], "failed")
                    self.assertIn("cleanup", saved["cleanup_error"])
                    self.assertIsNotNone(agent.backend)

    async def test_attach_retains_backend_until_verifier_and_exact_cleanup(self):
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append((command, kwargs))
                if "--version" in command:
                    return SimpleNamespace(return_code=0, stdout="fixture", stderr="")
                if "nohup" in command:
                    return SimpleNamespace(return_code=0, stdout="123\n456\n", stderr="")
                if "cat" in command and "attach-backend.stdout" in command:
                    return SimpleNamespace(return_code=0, stdout="zaovra server listening on http://127.0.0.1:4321", stderr="")
                if " run " in command:
                    return SimpleNamespace(return_code=0, stdout='{"type":"step_start"}\n{"type":"step_finish","event":{"properties":{"finish":"stop","usageReported":true,"tokens":{"input":1,"output":2}}}}\n', stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as directory:
            agent = Zaovra(logs_dir=Path(directory), revision="fixture", attach_backend=True)
            environment = Environment()
            await agent.setup(environment)
            context = AgentContext()
            await agent.run("Generic service request", environment, context)
            self.assertEqual(context.metadata["execution_ownership"], "attach")
            self.assertEqual(context.metadata["cli_exit_code"], 0)
            self.assertIn("--attach http://127.0.0.1:4321", calls[-1][0])
            self.assertFalse(any("kill -TERM" in command for command, _ in calls))
            self.assertIsNotNone(agent.backend)  # The verifier can still use the service.
            await agent.close_backend(environment)
            self.assertIn("/proc/123/stat", calls[-1][0])
            self.assertIn("456", calls[-1][0])
            self.assertIn("kill -TERM 123", calls[-1][0])
            self.assertIsNone(agent.backend)

    async def test_timeout_stops_owned_backend_without_extending_task(self):
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append(command)
                if " run " in command:
                    return SimpleNamespace(return_code=124, stdout="", stderr="timeout")
                return SimpleNamespace(return_code=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as directory:
            agent = Zaovra(logs_dir=Path(directory), attach_backend=True, timeout_sec=17)
            agent.backend = {"pid": 123, "start": "456", "url": "http://127.0.0.1:4321"}
            context = AgentContext()
            with self.assertRaises(RuntimeError):
                await agent.run("Generic service request", Environment(), context)
            self.assertIn("17s", calls[0])
            self.assertIn("kill -TERM 123", calls[-1])
            self.assertIsNone(agent.backend)
            self.assertEqual(context.metadata["cli_exit_code"], 124)
            self.assertFalse(context.metadata["complete"])

    async def test_attach_never_falls_back_to_local_without_ready_backend(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = Zaovra(logs_dir=Path(directory), attach_backend=True)
            with self.assertRaisesRegex(RuntimeError, "must be ready"):
                await agent.run("Generic task", None, AgentContext())

    async def test_nonzero_artifact_still_keeps_backend_for_verifier(self):
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append(command)
                return SimpleNamespace(return_code=1, stdout="", stderr="unverified")
        with tempfile.TemporaryDirectory() as directory:
            agent = Zaovra(logs_dir=Path(directory), attach_backend=True)
            agent.backend = {"pid": 123, "start": "456", "url": "http://127.0.0.1:4321"}
            context = AgentContext()
            with self.assertRaises(RuntimeError):
                await agent.run("Generic task", Environment(), context)
            self.assertEqual(len(calls), 1)
            self.assertIsNotNone(agent.backend)
            self.assertEqual(context.metadata["cli_exit_code"], 1)

    async def test_transport_failure_stops_exact_backend_and_remains_unknown(self):
        calls = []
        class Environment:
            async def exec(self, command, **kwargs):
                calls.append(command)
                if " run " in command:
                    raise OSError("transport unavailable")
                return SimpleNamespace(return_code=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as directory:
            agent = Zaovra(logs_dir=Path(directory), attach_backend=True)
            agent.backend = {"pid": 123, "start": "456", "url": "http://127.0.0.1:4321"}
            context = AgentContext()
            with self.assertRaises(OSError):
                await agent.run("Generic task", Environment(), context)
            self.assertIsNone(agent.backend)
            self.assertTrue(context.metadata["usage_unknown"])
            self.assertIn("kill -TERM 123", calls[-1])

class TrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.agent = Zaovra(logs_dir=Path("unused"), revision="fixture")

    def test_missing_usage_stays_unknown(self):
        context = AgentContext()
        self.agent.trajectory([{"type": "step_start"}, {"type": "step_finish", "event": {"properties": {"finish": "stop"}}}], "task", context)
        self.assertTrue(context.metadata["usage_unknown"])
        self.assertIsNone(context.n_input_tokens)

    def test_orphan_tool_error_preserves_diagnostic_without_inventing_call(self):
        context = AgentContext()
        events = [{"type": "step_start"}, {"type": "tool_error", "event": {"properties": {"callID": "orphan", "error": {"message": "blocked"}}}}, {"type": "error"}]
        trajectory = Trajectory.model_validate_json(self.agent.trajectory(events, "task", context).model_dump_json())
        observation = trajectory.steps[1].observation.results[0]
        self.assertIsNone(observation.source_call_id)
        self.assertEqual(observation.extra["original_call_id"], "orphan")
        self.assertEqual(json.loads(observation.content), {"message": "blocked"})
        self.assertFalse(trajectory.steps[1].tool_calls)
        self.assertFalse(context.metadata["complete"])
        self.assertTrue(context.metadata["usage_unknown"])

    def test_observation_before_call_attaches_to_actual_call_step(self):
        events = [{"type": "step_start"}, {"type": "tool_result", "event": {"properties": {"callID": "later", "content": "retained"}}}, {"type": "step_start"}, {"type": "tool_use", "event": {"properties": {"callID": "later", "tool": "bash", "input": {}}}}]
        trajectory = Trajectory.model_validate_json(self.agent.trajectory(events, "task", AgentContext()).model_dump_json())
        self.assertIsNone(trajectory.steps[1].observation)
        self.assertEqual(trajectory.steps[2].observation.results[0].source_call_id, "later")
        self.assertEqual(json.loads(trajectory.steps[2].observation.results[0].content), "retained")

    def test_late_observation_retains_original_call_owner(self):
        events = [{"type": "step_start"}, {"type": "tool_use", "event": {"properties": {"callID": "early", "tool": "bash", "input": {}}}}, {"type": "step_start"}, {"type": "tool_result", "event": {"properties": {"callID": "early", "content": "retained"}}}]
        trajectory = Trajectory.model_validate_json(self.agent.trajectory(events, "task", AgentContext()).model_dump_json())
        self.assertEqual(trajectory.steps[1].observation.results[0].source_call_id, "early")
        self.assertIsNone(trajectory.steps[2].observation)

    def test_unfinished_and_empty_are_not_complete(self):
        for events in [[], [{"type": "step_start"}], [{"type": "text", "event": {"properties": {"text": "partial"}}}]]:
            context = AgentContext()
            self.agent.trajectory(events, "task", context)
            self.assertFalse(context.metadata["complete"])
            self.assertTrue(context.metadata["usage_unknown"])

    def test_disjoint_usage_and_failed_completion(self):
        context = AgentContext()
        self.agent.trajectory([{"type": "step_start"}, {"type": "step_finish", "event": {"properties": {"finish": "stop", "usageReported": True, "tokens": {"input": 10, "output": 5, "reasoning": 7, "cache": {"read": 20, "write": 3}}}}}, {"type": "error"}], "task", context)
        self.assertEqual(context.metadata["known_tokens"], {"input": 33, "output": 12, "cache": 20})
        self.assertFalse(context.metadata["complete"])
        self.assertTrue(context.metadata["usage_unknown"])

    def test_tool_observation_links_survive_atif_validation(self):
        context = AgentContext()
        events = [{"type": "step_start"}, {"type": "tool_use", "event": {"properties": {"callID": "call-1", "tool": "bash", "input": {"command": "echo fixture"}}}}, {"type": "tool_result", "event": {"properties": {"callID": "call-1", "content": [{"type": "text", "text": "fixture"}], "structured": {"exit": 0}}}}, {"type": "step_finish", "event": {"properties": {"finish": "stop", "usageReported": True, "tokens": {"input": 1, "output": 2}}}}]
        trajectory = Trajectory.model_validate_json(self.agent.trajectory(events, "task", context).model_dump_json())
        self.assertEqual(trajectory.steps[1].tool_calls[0].tool_call_id, trajectory.steps[1].observation.results[0].source_call_id)
        self.assertTrue(context.metadata["complete"])

if __name__ == "__main__":
    unittest.main()
