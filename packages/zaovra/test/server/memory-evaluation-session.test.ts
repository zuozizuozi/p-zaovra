import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { link, mkdir } from "node:fs/promises"
import { openJob } from "../../../../script/evaluation/memory/job"
import { runEvaluationSession } from "../../../../script/evaluation/memory/session"
import { tmpdir } from "../fixture/fixture"

test.skipIf(process.platform !== "win32")(
  "evaluation runs new Sessions across backend restarts and rejects failed turns",
  async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "workspace")
    const profile = path.join(tmp.path, "profile")
    await mkdir(directory)
    await mkdir(profile)
    await Bun.write(path.join(profile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n")
    let calls = 0
    let reject = false
    // Only the upstream is scripted. The backend is the standalone executable under its native Job.
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        if (reject)
          return Response.json(
            { error: { message: "fixture rejected", type: "invalid_request_error" } },
            { status: 400 },
          )
        const chunk = (choices: unknown[], usage?: object) =>
          `data: ${JSON.stringify({ id: "session-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
        return new Response(
          chunk([
            { index: 0, delta: { role: "assistant", content: "Private fixture response." }, finish_reason: null },
          ]) +
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
            chunk([], { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await Bun.write(
      path.join(directory, "zaovra.json"),
      JSON.stringify({
        model: "session-fixture/fixture-model",
        memory: { enabled: false },
        provider: {
          "session-fixture": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
            models: { "fixture-model": { limit: { context: 32000, output: 1024 } } },
          },
        },
      }),
    )
    const execute = async (stage: string) => {
      try {
        return await runEvaluationSession({
          directory,
          profile,
          stage: path.join(tmp.path, stage),
          model: { id: "fixture-model", providerID: "session-fixture" },
          prompt: "Private fixture prompt. Reply once, do not use tools.",
          seconds: 30,
        })
      } catch (error) {
        // This local fixture has no credentials or real model data. Preserve startup diagnostics on failure.
        const log = Bun.file(path.join(tmp.path, stage, "backend.log"))
        if (await log.exists()) console.error((await log.text()).slice(-16000))
        const incomplete = Bun.file(path.join(tmp.path, stage, "incomplete.json"))
        if (await incomplete.exists()) console.error(await incomplete.text())
        console.error({ fixtureCalls: calls })
        throw error
      }
    }
    try {
      const first = await execute("first")
      const second = await execute("second")
      expect(first.admission.sessionID).not.toBe(second.admission.sessionID)
      expect(first.generation).not.toBe(second.generation)
      expect(first.stopped.scope).not.toBe(second.stopped.scope)
      for (const result of [first, second]) {
        expect(result.observation.artifactReady).toBe(true)
        expect(result.diagnostics.coverage.status).toBe("complete-through-cut")
        expect(result.diagnostics.billing).toMatchObject({ status: "unknown", total: null, reserve: "retain" })
        expect(result.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
        expect(JSON.stringify(result)).not.toContain("Private fixture")
      }
      expect(calls).toBe(2)
      // Open only after both backend Job trees stopped; verify actual disk persistence across the restart.
      {
        using db = new Database(path.join(profile, "sessions.sqlite"), { readonly: true })
        expect(
          db
            .query("select id from session where id in (?, ?) order by id")
            .all(first.admission.sessionID, second.admission.sessionID),
        ).toHaveLength(2)
      }
      const otherProfile = path.join(tmp.path, "other-profile")
      await mkdir(otherProfile)
      await Bun.write(path.join(otherProfile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n")
      const other = await runEvaluationSession({
        directory,
        profile: otherProfile,
        stage: path.join(tmp.path, "other-stage"),
        model: { id: "fixture-model", providerID: "session-fixture" },
        prompt: "Reply once.",
        seconds: 30,
      })
      {
        using db = new Database(path.join(otherProfile, "sessions.sqlite"), { readonly: true })
        expect(
          db
            .query("select id from session where id in (?, ?)")
            .all(first.admission.sessionID, second.admission.sessionID),
        ).toEqual([])
        expect(db.query("select id from session where id = ?").all(other.admission.sessionID)).toHaveLength(1)
      }
      reject = true
      await expect(execute("rejected")).rejects.toThrow("evaluation-session-not-completed")
      expect(calls).toBe(4)
      await expect(execute("first")).rejects.toThrow()
      expect(calls).toBe(4)
    } finally {
      await provider.stop(true)
    }
  },
  120000,
)

test.skipIf(process.platform !== "win32")("profile overlap and database hard links fail before launching", async () => {
  await using tmp = await tmpdir()
  const profile = path.join(tmp.path, "profile")
  const directory = path.join(tmp.path, "workspace")
  await mkdir(profile)
  await mkdir(directory)
  await Bun.write(path.join(profile, ".evaluation-profile"), "zaovra-memory-evaluation-v1\n")
  const input = {
    profile,
    directory,
    stage: path.join(tmp.path, "stage"),
    model: { id: "unused", providerID: "unused" },
    prompt: "unused",
  }
  await expect(runEvaluationSession({ ...input, directory: profile })).rejects.toThrow(
    "overlapping-evaluation-directories",
  )
  await expect(runEvaluationSession({ ...input, stage: path.join(directory, "stage") })).rejects.toThrow(
    "overlapping-evaluation-directories",
  )
  await expect(
    runEvaluationSession({ ...input, providerEnvironment: { OPENAI_API_KEY: "fixture-only" } }),
  ).rejects.toThrow("invalid-evaluation-provider-environment")
  const outside = path.join(tmp.path, "outside.sqlite")
  await Bun.write(outside, "outside unchanged")
  await link(outside, path.join(profile, "sessions.sqlite"))
  await expect(runEvaluationSession(input)).rejects.toThrow("evaluation-database-alias")
  expect(await Bun.file(outside).text()).toBe("outside unchanged")
  expect(await Bun.file(path.join(input.stage, "backend.log")).exists()).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "launcher validates isolation before loading product modules and ignores dotenv",
  async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "bunfig.toml")
    await Bun.write(config, "preload = []\n")
    await Bun.write(path.join(tmp.path, ".env"), "ZAOVRA_EVAL_SENTINEL=from-dotenv\n")
    const probe = path.join(tmp.path, "probe.ts")
    await Bun.write(
      probe,
      `if (process.env.ZAOVRA_EVAL_SENTINEL) process.exit(29); await import(${JSON.stringify(path.resolve(import.meta.dir, "../../script/memory-evaluation-backend.ts"))})`,
    )
    const environment = Object.fromEntries(
      ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    )
    const forbidden = path.join(tmp.path, "must-not-be-created")
    Object.assign(environment, {
      HOME: forbidden,
      USERPROFILE: forbidden,
      XDG_DATA_HOME: forbidden,
      XDG_CONFIG_HOME: forbidden,
      XDG_CACHE_HOME: forbidden,
      XDG_STATE_HOME: forbidden,
      ZAOVRA_TEST_HOME: forbidden,
      ZAOVRA_TEST_MANAGED_CONFIG_DIR: forbidden,
    })
    await using owner = await openJob({
      directory: tmp.path,
      log: path.join(tmp.path, "preflight.log"),
      seconds: 10,
      environment,
      command: [
        process.execPath,
        "run",
        "--no-env-file",
        "--no-install",
        `--config=${config}`,
        probe,
        path.join(tmp.path, "ready.json"),
        "11111111-1111-4111-8111-111111111111",
      ],
    })
    const deadline = Date.now() + 8000
    while ((await owner.inspect()).rootAlive && Date.now() < deadline) await Bun.sleep(25)
    const stopped = await owner.stop()
    expect(stopped.rootExit).toBe(1)
    expect(await Bun.file(path.join(tmp.path, "preflight.log")).text()).toContain("missing-isolated-evaluation-path")
    expect(stopped.remaining).toEqual([])
    expect(await Bun.file(path.join(tmp.path, "ready.json")).exists()).toBe(false)
    const { existsSync } = await import("node:fs")
    expect(existsSync(forbidden)).toBe(false)
  },
)
