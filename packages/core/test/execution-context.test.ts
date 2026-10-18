import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { ExecutionContext } from "../src/session/execution-context"
import { SessionOutcome } from "../src/session/outcome"
import { SessionMessage } from "../src/session/message"
import { tmpdir } from "./fixture/tmpdir"

test("K3 comments and quoted literals are not observed environment changes", () => {
  for (const command of ["node cli.js # OMP_NUM_THREADS=1", "node cli.js 'OMP_NUM_THREADS=1'"])
    expect(ExecutionContext.problems(ExecutionContext.capture(command, "/project", 5000, false))).toEqual([])
})

test("K3 current approved contract invalidates changed entry or required unknown runtime, not unrelated observations", () => {
  const approved = {
    sourceMessageID: "msg_user",
    value: { version: 1 as const, entry: "node cli.js", environment: { OMP_NUM_THREADS: "2" } },
  }
  const captured = ExecutionContext.bind(
    ExecutionContext.capture("node cli.js", "/project", 5000, false, { OMP_NUM_THREADS: "2" }, ["OMP_NUM_THREADS"]),
    approved,
  )
  expect(ExecutionContext.problems(captured, ExecutionContext.current(captured, approved))).toEqual([])
  const changed = { ...approved, value: { ...approved.value, entry: "node alternate.js" } }
  expect(ExecutionContext.problems(captured, ExecutionContext.current(captured, changed)).join(" ")).toContain(
    "entry: requested condition was not observed",
  )
  const requiredRuntime = { ...approved, value: { ...approved.value, runtime: "node 22" } }
  expect(ExecutionContext.problems(captured, ExecutionContext.current(captured, requiredRuntime)).join(" ")).toContain(
    "runtime: requested condition was not observed",
  )
  expect(
    ExecutionContext.approved([{ type: "assistant", id: "model", executionContract: approved.value }]),
  ).toBeUndefined()
})

test("K1 actual program: diagnostic one-thread success cannot certify the failing agreed entry", async () => {
  await using root = await tmpdir()
  const script = `${root.path}/contract.cjs`
  await Bun.write(
    script,
    `console.log(JSON.stringify({ threads: process.env.OMP_NUM_THREADS, version: process.version })); process.exit(process.argv[2] === 'cli' && process.env.OMP_NUM_THREADS !== '1' ? 1 : 0)`,
  )
  const run = async (threads: string, entry: string) => {
    const child = Bun.spawn([process.execPath, script, entry], {
      cwd: root.path,
      env: { ...process.env, OMP_NUM_THREADS: threads },
      stdout: "pipe",
      stderr: "pipe",
    })
    return {
      exit: await child.exited,
      observed: Schema.decodeUnknownSync(Schema.Struct({ threads: Schema.String, version: Schema.String }))(
        await new Response(child.stdout).json(),
      ),
    }
  }
  const diagnostic = await run("1", "cli")
  const agreed = await run("8", "cli")
  const internal = await run("8", "unit")
  expect([diagnostic.exit, agreed.exit, internal.exit]).toEqual([0, 1, 0])
  const context = {
    ...ExecutionContext.capture(`${process.execPath} ${script} cli`, root.path, 30000, false),
    environment: {
      OMP_NUM_THREADS: {
        requested: { value: "8", source: "user" as const },
        observed: { value: String(diagnostic.observed.threads), source: "diagnostic-temporary" as const },
      },
    },
  }
  expect(ExecutionContext.problems(context, context)).toContain("OMP_NUM_THREADS: requested condition was not observed")
  const accepted = {
    ...context,
    environment: {
      OMP_NUM_THREADS: { ...context.environment.OMP_NUM_THREADS, requested: { value: "1", source: "user" as const } },
    },
  }
  expect(ExecutionContext.problems(accepted, accepted)).toEqual([])
  expect(context.runtime.observed).toEqual({ value: null, source: "unknown" })
})

test("K1 capture excludes secrets and rejects a rewritten execution certificate", () => {
  const context = ExecutionContext.capture("node cli.js", "/project", 5000, true, { OMP_NUM_THREADS: "1" }, [
    "OMP_NUM_THREADS",
  ])
  expect(Object.keys(context.environment).sort()).toEqual([
    "BLIS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
  ])
  expect(ExecutionContext.problems(context).join(" ")).toContain("diagnostic temporary")
  const clean = ExecutionContext.capture("node cli.js", "/project", 5000, false)
  const check = {
    kind: "test" as const,
    command: "node cli.js",
    exit: 0,
    callID: "real",
    snapshot: "same",
    executionContext: clean,
    contractDigest: "forged",
  }
  expect(SessionOutcome.checkFreshness(check, [], "same").fresh).toBe(false)
})

for (const output of ["0 pass\n3 skip\n0 fail", "collected 0 items", "Tests: 3 skipped, 3 total"]) {
  test(`K1 empty or all-skipped success is not functional evidence: ${output}`, () => {
    const tool: SessionMessage.AssistantTool = {
      type: "tool",
      id: "check",
      name: "bash",
      time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
      state: {
        status: "completed",
        input: {},
        content: [{ type: "text", text: output }],
        structured: { verification: { kind: "test", command: "test-runner", exit: 0, callID: "check" } },
      },
    }
    expect(SessionOutcome.toolChecks(tool)[0]?.execution).toBe("invalid-report")
  })
}
