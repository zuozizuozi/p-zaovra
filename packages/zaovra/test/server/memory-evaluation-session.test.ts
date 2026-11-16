import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { link, mkdir } from "node:fs/promises"
import { openJob } from "../../../../script/evaluation/memory/job"
import { runEvaluationSession } from "../../../../script/evaluation/memory/session"
import { chains } from "../../../../script/evaluation/memory/cases"
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
    let failure: "http" | "permission" | undefined
    const requests: string[] = []
    // Only the upstream is scripted. The backend is the standalone executable under its native Job.
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(await request.text())
        calls++
        if (failure === "http")
          return Response.json(
            { error: { message: "fixture rejected", type: "invalid_request_error" } },
            { status: 400 },
          )
        const chunk = (choices: unknown[], usage?: object) =>
          `data: ${JSON.stringify({ id: "session-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
        if (failure === "permission")
          return new Response(
            chunk([
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "denied-command",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "$x = 'private-fixture-command'; Write-Output $x" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]) +
              chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]) +
              chunk([], { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          )
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
        shell: "powershell",
        agent: { build: { steps: 8 } },
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
    const execute = async (
      stage: string,
      sourceSessionID?: string,
      kernelExperiment?: Parameters<typeof runEvaluationSession>[0]["kernelExperiment"],
    ) => {
      try {
        return await runEvaluationSession({
          directory,
          profile,
          stage: path.join(tmp.path, stage),
          model: { id: "fixture-model", providerID: "session-fixture" },
          prompt: "Private fixture prompt. Reply once, do not use tools.",
          seconds: 30,
          kernelExperiment,
          ...(sourceSessionID ? { poison: { chain: "billing", sourceSessionID } } : {}),
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
      const first = await execute("first", undefined, { factor: "accuracy-general", value: "on" })
      const second = await execute("second", first.admission.sessionID, { factor: "accuracy-general", value: "off" })
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
      // These are actual requests received from separate backend processes, not manifest echoes.
      expect(requests[0]).toContain("An ordinary SQLite connection can checkpoint or consume WAL")
      expect(requests[1]).not.toContain("An ordinary SQLite connection can checkpoint or consume WAL")
      for (const [stage, value] of [
        ["first", "on"],
        ["second", "off"],
      ]) {
        const experiment = await Bun.file(path.join(tmp.path, stage, "kernel-experiment.json")).json()
        expect(experiment).toMatchObject({
          factor: "accuracy-general",
          value,
          evidence: "launch-input",
          environment: {
            ZAOVRA_EXPERIMENTAL_ACCURACY_GENERAL: value,
            ZAOVRA_EXPERIMENTAL_DELIVERY_REPAIR: "on",
            ZAOVRA_EXPERIMENTAL_ACCURACY_SCALE: "on",
            ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE: "original",
            ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE: "en",
          },
        })
      }
      const seeded = await Bun.file(path.join(tmp.path, "second", "fixture.json")).json()
      expect(seeded).toMatchObject({ chain: "billing", sourceSessionID: first.admission.sessionID })
      expect(seeded.after).toHaveLength(seeded.before.length + 1)
      expect(seeded.after.find((note: { id: string }) => note.id === seeded.inserted)).toMatchObject({
        origin: "model",
        status: "verified",
      })
      // Open only after both backend Job trees stopped; verify actual disk persistence across the restart.
      {
        using db = new Database(path.join(profile, "sessions.sqlite"), { readonly: true })
        expect(
          db
            .query("select id from session where id in (?, ?) order by id")
            .all(first.admission.sessionID, second.admission.sessionID),
        ).toHaveLength(2)
        expect(
          db.query("select origin, status, verification from memory_note where id = ?").get(seeded.inserted),
        ).toMatchObject({ origin: "model", status: "verified", verification: "Recorded operational guidance." })
      }
      await expect(execute("duplicate-fixture", first.admission.sessionID)).rejects.toThrow(
        "evaluation-backend-ended-before-ready",
      )
      expect(calls).toBe(2)
      const poisonedNote = chains.find((chain) => chain.id === "billing")!.poisonedNote
      expect(requests[1]).not.toContain(poisonedNote)
      const configFile = Bun.file(path.join(directory, "zaovra.json"))
      const config = await configFile.json()
      await Bun.write(
        configFile,
        JSON.stringify({ ...config, memory: { enabled: true, taskSearch: false, index: { enabled: true } } }),
      )
      const indexed = await execute("indexed")
      expect(indexed.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
      expect(requests[2]).toContain(poisonedNote)
      expect(requests[2]).not.toContain("intentionally false")
      expect(requests[2]).not.toContain("artificial-poison")
      expect(requests[2]).toContain("An ordinary SQLite connection can checkpoint or consume WAL")
      expect(await Bun.file(path.join(tmp.path, "indexed", "kernel-experiment.json")).exists()).toBe(false)
      await Bun.write(configFile, JSON.stringify(config))
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
      failure = "http"
      await expect(execute("rejected")).rejects.toThrow("evaluation-session-not-completed")
      expect(calls).toBe(5)
      failure = "permission"
      await Bun.write(
        configFile,
        JSON.stringify({ ...config, permission: { "*": "allow", external_directory: "deny" } }),
      )
      await expect(execute("denied-command")).rejects.toThrow("evaluation-session-not-completed")
      expect(calls).toBe(6)
      for (const stage of ["rejected", "denied-command"]) {
        const incomplete = await Bun.file(path.join(tmp.path, stage, "incomplete.json")).json()
        expect(incomplete.admission.sessionID).toBeString()
        expect(incomplete.admission.id).toBeString()
        expect(incomplete.lastObservation.artifactReady).toBe(false)
        expect(["own-assistant-terminated", "outcome-not-completed"]).toContain(incomplete.lastObservation.reason)
        expect(incomplete.lastObservation.turnEvidence).toBeUndefined()
        expect(incomplete.stopped).toMatchObject({ remaining: [], controllerExit: 0 })
        expect(JSON.stringify(incomplete)).not.toContain("Private fixture")
        expect(JSON.stringify(incomplete)).not.toContain("private-fixture-command")
        expect(await Bun.file(path.join(tmp.path, stage, "session.json")).exists()).toBe(false)
        expect(await Bun.file(path.join(tmp.path, stage, "grade.json")).exists()).toBe(false)
      }
      await expect(execute("first")).rejects.toThrow()
      expect(calls).toBe(6)
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
  await expect(
    runEvaluationSession({ ...input, providerEnvironment: { ZAOVRA_EXPERIMENTAL_ACCURACY_GENERAL: "off" } }),
  ).rejects.toThrow("invalid-evaluation-provider-environment")
  for (const kernelExperiment of [
    null,
    { factor: "unknown", value: "off" },
    { factor: "__proto__", value: "off" },
    { factor: "accuracy-general", value: "zh" },
    { factor: "accuracy-general", value: "off", extra: "ignored" },
    { factor: "host-hint-style", value: "off" },
  ])
    await expect(runEvaluationSession({ ...input, kernelExperiment: kernelExperiment as never })).rejects.toThrow(
      "invalid-kernel-experiment",
    )
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
      // Bun may cache imported source before executing the entrypoint's isolation checks.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(tmp.path, "transpiler-cache"),
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
