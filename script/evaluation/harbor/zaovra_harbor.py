"""Harbor 0.24 adapter for Zaovra's real V2 headless CLI; no model/tool loop here."""
import json
import shlex
from pathlib import Path
from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, Metrics, Observation, ObservationResult, Step, ToolCall, Trajectory

class Zaovra(BaseAgent):
    capabilities = AgentCapabilities(atif=True)

    def __init__(self, *args, command=None, revision="unknown", directory=None, timeout_sec=120, **kwargs):
        super().__init__(*args, **kwargs)
        self.command = command or ["zaovra"]
        self.revision = revision
        self.directory = directory
        self.timeout_sec = timeout_sec

    @staticmethod
    def name():
        return "zaovra"

    def version(self):
        return self.revision

    async def setup(self, environment: BaseEnvironment):
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        result = await environment.exec(shlex.join([*self.command, "--version"]), env=self.extra_env, timeout_sec=30)
        (self.logs_dir / "version.txt").write_text(result.stdout or "", encoding="utf-8")
        if result.return_code:
            raise RuntimeError("Zaovra CLI version preflight failed")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext):
        args = [*self.command, "run", "--format", "json", "--thinking"]
        if self.model_name:
            args += ["--model", self.model_name]
        if self.directory:
            args += ["--dir", self.directory]
        args += ["--", instruction]
        try:
            result = await environment.exec(shlex.join(args), env=self.extra_env, timeout_sec=self.timeout_sec)
        except BaseException as error:
            context.metadata = {"complete": False, "error_type": type(error).__name__, "usage_unknown": True}
            (self.logs_dir / "context.json").write_text(context.model_dump_json(indent=2), encoding="utf-8")
            raise
        (self.logs_dir / "stdout.jsonl").write_text(result.stdout or "", encoding="utf-8")
        (self.logs_dir / "stderr.txt").write_text(result.stderr or "", encoding="utf-8")
        events = []
        for line in (result.stdout or "").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict) and row.get("type"):
                events.append(row)
        trajectory = self.trajectory(events, instruction, context)
        (self.logs_dir / "trajectory.json").write_text(trajectory.model_dump_json(indent=2, exclude_none=True), encoding="utf-8")
        (self.logs_dir / "context.json").write_text(context.model_dump_json(indent=2), encoding="utf-8")
        if result.return_code or not context.metadata["complete"]:
            raise RuntimeError("Zaovra CLI did not end successfully; inspect raw events and context")

    def trajectory(self, events, instruction, context):
        steps = [Step(step_id=1, source="user", message=instruction)]
        current = None
        calls = {}
        totals = {"input": 0, "output": 0, "cache": 0}
        unknown = False
        terminal = False
        for row in events:
            kind = row.get("type")
            data = row.get("event", {}).get("properties", {})
            if kind == "step_start":
                current = Step(step_id=len(steps)+1, source="agent", message="", model_name=self.model_name)
                steps.append(current)
            if kind == "error":
                terminal = False
                unknown = True
            if current is None:
                continue
            if kind == "text":
                current.message += data.get("text", "")
            if kind == "reasoning":
                current.reasoning_content = (current.reasoning_content or "") + data.get("text", "")
            if kind == "tool_use":
                call = ToolCall(tool_call_id=data["callID"], function_name=data["tool"], arguments=data.get("input", {}))
                current.tool_calls = [*(current.tool_calls or []), call]
                calls[data["callID"]] = current
            if kind in ("tool_result", "tool_error"):
                owner = calls.get(data.get("callID"), current)
                observation = ObservationResult(source_call_id=data.get("callID"), content=json.dumps(data.get("content", data.get("error", {})), ensure_ascii=False), extra={"type": kind, "structured": data.get("structured")})
                owner.observation = Observation(results=[*(owner.observation.results if owner.observation else []), observation])
            if kind == "step_finish":
                token = data.get("tokens", {})
                reported = data.get("usageReported") is True
                unknown |= not reported
                if reported:
                    cache = token.get("cache", {})
                    inp = token.get("input", 0) + cache.get("read", 0) + cache.get("write", 0)
                    out = token.get("output", 0) + token.get("reasoning", 0)
                    current.metrics = Metrics(prompt_tokens=inp, completion_tokens=out, cached_tokens=cache.get("read", 0))
                    totals["input"] += inp
                    totals["output"] += out
                    totals["cache"] += cache.get("read", 0)
                current.extra = {"finish": data.get("finish"), "usage_reported": reported}
                terminal = data.get("finish") in ("stop", "end-turn", "end_turn")
        unknown |= len(steps) == 1 or any(s.extra is None for s in steps[1:])
        context.metadata = {"complete": terminal and not any(e.get("type")=="error" for e in events), "usage_unknown": unknown, "provider_turns": len(steps)-1, "known_tokens": totals}
        if not unknown:
            context.n_input_tokens = totals["input"]
            context.n_output_tokens = totals["output"]
            context.n_cache_tokens = totals["cache"]
        return Trajectory(session_id=next((e.get("sessionID") for e in events if e.get("sessionID")), None), agent=Agent(name=self.name(), version=self.version(), model_name=self.model_name), steps=steps)
