"""Harbor 0.24 adapter for Zaovra's real V2 headless CLI; no model/tool loop here."""
import asyncio
import json
import re
import shlex
import time
from pathlib import Path
from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, Metrics, Observation, ObservationResult, Step, ToolCall, Trajectory

class Zaovra(BaseAgent):
    capabilities = AgentCapabilities(atif=True)

    def __init__(self, *args, command=None, revision="unknown", directory=None, timeout_sec=120, attach_backend=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.command = command or ["zaovra"]
        self.revision = revision
        self.directory = directory
        self.timeout_sec = timeout_sec
        self.attach_backend = attach_backend
        self.backend = None

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
        if self.attach_backend:
            await self.start_backend(environment)

    async def start_backend(self, environment):
        # The evaluation owns this backend. Model tools must still use Bash jobs.
        prefix = str(self.environment_logs_dir / "attach-backend")
        command = shlex.join([*self.command, "serve", "--hostname", "127.0.0.1", "--port", "0"])
        launched = await environment.exec(
            f"nohup {command} > {shlex.quote(prefix + '.stdout')} 2> {shlex.quote(prefix + '.stderr')} < /dev/null & "
            f"pid=$!; printf '%s\\n' \"$pid\"; awk '{{print $22}}' /proc/$pid/stat",
            env=self.extra_env, timeout_sec=10,
        )
        identity = (launched.stdout or "").splitlines()
        if launched.return_code or len(identity) != 2 or not all(value.isdigit() for value in identity):
            raise RuntimeError("Attach backend did not return an exact process identity")
        self.backend = {"pid": int(identity[0]), "start": identity[1], "url": None}
        try:
            until = time.monotonic() + 30
            while time.monotonic() < until:
                ready = await environment.exec(
                    f"kill -0 {self.backend['pid']} && cat {shlex.quote(prefix + '.stdout')}",
                    timeout_sec=5,
                )
                if ready.return_code:
                    raise RuntimeError("Attach backend exited before readiness")
                match = re.search(r"zaovra server listening on (http://127\.0\.0\.1:[1-9][0-9]*)", ready.stdout or "")
                if match:
                    self.backend["url"] = match.group(1)
                    (self.logs_dir / "ownership.json").write_text(
                        json.dumps({"mode": "attach", **self.backend, "cleanup": "after verifier by trial container teardown"}),
                        encoding="utf-8",
                    )
                    return
                await asyncio.sleep(0.1)
            raise RuntimeError("Attach backend readiness timed out")
        except BaseException:
            await self.close_backend(environment)
            raise

    async def close_backend(self, environment):
        if not self.backend:
            return
        pid = self.backend["pid"]
        # Birth time guards against PID reuse; never match names or listening ports.
        result = await environment.exec(
            f"if [ \"$(awk '{{print $22}}' /proc/{pid}/stat 2>/dev/null)\" = {shlex.quote(self.backend['start'])} ]; then "
            f"kill -TERM {pid}; for i in 1 2 3 4 5; do kill -0 {pid} 2>/dev/null || break; sleep 1; done; "
            f"if [ \"$(awk '{{print $22}}' /proc/{pid}/stat 2>/dev/null)\" = {shlex.quote(self.backend['start'])} ]; then kill -KILL {pid}; fi; fi",
            timeout_sec=10,
        )
        if result.return_code:
            raise RuntimeError("Exact attach backend cleanup failed")
        self.backend = None

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext):
        args = [*self.command, "run", "--format", "json", "--thinking"]
        if self.attach_backend:
            if not self.backend or not self.backend["url"]:
                raise RuntimeError("Attach backend must be ready before running the agent")
            args += ["--attach", self.backend["url"]]
        if self.model_name:
            args += ["--model", self.model_name]
        if self.directory:
            args += ["--dir", self.directory]
        args += ["--", instruction]
        try:
            # Keep partial logs on the trial mount. Only the client has the task
            # timeout; a successful attach backend lives through verification.
            stdout = shlex.quote(str(self.environment_logs_dir / "stdout.jsonl"))
            stderr = shlex.quote(str(self.environment_logs_dir / "stderr.txt"))
            command = (
                f"timeout --signal=TERM --kill-after=5s {self.timeout_sec}s {shlex.join(args)} > {stdout} 2> {stderr}; code=$?; cat {stdout}; cat {stderr} >&2; exit $code"
                if self.attach_backend else shlex.join(args)
            )
            result = await environment.exec(command, env=self.extra_env, timeout_sec=self.timeout_sec + (10 if self.attach_backend else 0))
        except BaseException as error:
            if self.attach_backend:
                await self.close_backend(environment)
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
        context.metadata["cli_exit_code"] = result.return_code
        context.metadata["execution_ownership"] = "attach" if self.attach_backend else "local-cli"
        (self.logs_dir / "trajectory.json").write_text(trajectory.model_dump_json(indent=2, exclude_none=True), encoding="utf-8")
        (self.logs_dir / "context.json").write_text(context.model_dump_json(indent=2), encoding="utf-8")
        if result.return_code or not context.metadata["complete"]:
            if self.attach_backend and result.return_code in (124, 137):
                await self.close_backend(environment)
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
