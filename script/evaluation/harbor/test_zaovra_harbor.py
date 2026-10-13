import unittest
from pathlib import Path
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from zaovra_harbor import Zaovra

class TrajectoryTests(unittest.TestCase):
    def setUp(self):
        self.agent = Zaovra(logs_dir=Path("unused"), revision="fixture")

    def test_missing_usage_stays_unknown(self):
        context = AgentContext()
        self.agent.trajectory([{"type": "step_start"}, {"type": "step_finish", "event": {"properties": {"finish": "stop"}}}], "task", context)
        self.assertTrue(context.metadata["usage_unknown"])
        self.assertIsNone(context.n_input_tokens)

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
