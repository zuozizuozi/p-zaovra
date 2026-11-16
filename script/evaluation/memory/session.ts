/// <reference lib="dom" />
import path from "node:path"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Zaovra } from "@zaovra-ai/client"
import { openJob } from "./job"
import { observe, validCapture } from "./observe"
import type { CaptureBounds } from "./observe"
import type { createMemoryAuthority } from "./memory-authority"
import { collectHistory } from "./history"

/** One new Session in an isolated, persistent profile; no retry admits another prompt.
 * Caller owns the trusted profile/workspace exclusively until this call settles. This is process
 * containment and conservative sampling, not a security sandbox or atomic artifact snapshot.
 */
export async function runEvaluationSession(input: {
  directory: string
  profile: string
  stage: string
  model: { id: string; providerID: string }
  prompt: string
  seconds?: number
  providerEnvironment?: Record<string, string>
  /** One kernel factor; other factors use the fixed baseline, never ambient environment values. */
  kernelExperiment?:
    | { factor: "delivery-repair" | "accuracy-general" | "accuracy-scale"; value: "on" | "off" }
    | { factor: "host-hint-style"; value: "original" | "short" }
    | { factor: "host-hint-language"; value: "en" | "zh" }
  memoryAuthority?: ReturnType<typeof createMemoryAuthority>
  poison?: { chain: string; sourceSessionID: string }
  /** Opt-in sensitive own-turn projection; delivered only after final consistency and empty Job. */
  capture?: CaptureBounds
}) {
  const seconds = input.seconds ?? 180
  if (
    [input.directory, input.profile, input.stage].some((value) => !path.isAbsolute(value)) ||
    !Number.isInteger(seconds) ||
    seconds < 10 ||
    seconds > 600 ||
    !validCapture(input.capture) ||
    !input.prompt.trim()
  )
    throw new Error("invalid-evaluation-session")
  if (
    Object.keys(input.providerEnvironment ?? {}).some(
      (name) => !/^ZAOVRA_EVAL_[A-Z0-9_]+$/.test(name) || name.startsWith("ZAOVRA_EVAL_MEMORY_"),
    )
  )
    throw new Error("invalid-evaluation-provider-environment")
  const factors = {
    "delivery-repair": { variable: "ZAOVRA_EXPERIMENTAL_DELIVERY_REPAIR", values: ["on", "off"] },
    "accuracy-general": { variable: "ZAOVRA_EXPERIMENTAL_ACCURACY_GENERAL", values: ["on", "off"] },
    "accuracy-scale": { variable: "ZAOVRA_EXPERIMENTAL_ACCURACY_SCALE", values: ["on", "off"] },
    "host-hint-style": { variable: "ZAOVRA_EXPERIMENTAL_HOST_HINT_STYLE", values: ["original", "short"] },
    "host-hint-language": { variable: "ZAOVRA_EXPERIMENTAL_HOST_HINT_LANGUAGE", values: ["en", "zh"] },
  }
  if (
    input.kernelExperiment !== undefined &&
    (!record(input.kernelExperiment) ||
      Object.keys(input.kernelExperiment).length !== 2 ||
      typeof input.kernelExperiment.factor !== "string" ||
      typeof input.kernelExperiment.value !== "string" ||
      !Object.hasOwn(factors, input.kernelExperiment.factor) ||
      !factors[input.kernelExperiment.factor].values.includes(input.kernelExperiment.value))
  )
    throw new Error("invalid-kernel-experiment")
  const kernelEnvironment = input.kernelExperiment
    ? Object.fromEntries(
        Object.entries(factors).map(([factor, entry]) => [
          entry.variable,
          factor === input.kernelExperiment!.factor ? input.kernelExperiment!.value : entry.values[0],
        ]),
      )
    : {}
  const paths = [input.directory, input.profile, input.stage].map((value) => path.resolve(value).toLowerCase())
  if (
    paths.some((value, index) =>
      paths.some(
        (other, otherIndex) => index !== otherIndex && (value === other || value.startsWith(other + path.sep)),
      ),
    )
  )
    throw new Error("overlapping-evaluation-directories")
  for (const directory of [input.profile, input.directory, path.dirname(input.stage)]) {
    const actual = await realpath(directory)
    if (path.resolve(directory).toLowerCase() !== actual.toLowerCase() || !(await lstat(directory)).isDirectory())
      throw new Error("evaluation-directory-alias")
  }
  // The caller creates a new profile explicitly. Refuse normal user data directories.
  if ((await readFile(path.join(input.profile, ".evaluation-profile"), "utf8")) !== "zaovra-memory-evaluation-v1\n")
    throw new Error("not-an-evaluation-profile")
  for (const name of ["sessions.sqlite", "sessions.sqlite-wal", "sessions.sqlite-shm", "sessions.sqlite-journal"]) {
    const info = await lstat(path.join(input.profile, name)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
      throw new Error("evaluation-database-alias")
  }
  await mkdir(input.stage)
  const generation = randomUUID()
  await using memoryStage = input.memoryAuthority?.openStage(generation, input.directory)
  const readyFile = path.join(input.stage, "ready.json")
  const bunConfig = path.join(input.stage, "bunfig.toml")
  await Bun.write(bunConfig, "preload = []\n")
  const fixtureFile = path.join(input.stage, "fixture-request.json")
  if (input.poison) await Bun.write(fixtureFile, JSON.stringify({ ...input.poison, directory: input.directory }))
  const environment = Object.fromEntries(
    [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  )
  for (const [key, directory] of Object.entries({
    TEMP: path.join(input.stage, "temp"),
    TMP: path.join(input.stage, "temp"),
    TMPDIR: path.join(input.stage, "temp"),
    XDG_DATA_HOME: path.join(input.profile, "data"),
    XDG_CONFIG_HOME: path.join(input.profile, "config"),
    XDG_CACHE_HOME: path.join(input.profile, "cache"),
    XDG_STATE_HOME: path.join(input.profile, "state"),
    ZAOVRA_TEST_HOME: path.join(input.profile, "home"),
    HOME: path.join(input.profile, "home"),
    USERPROFILE: path.join(input.profile, "home"),
    ZAOVRA_TEST_MANAGED_CONFIG_DIR: path.join(input.profile, "managed"),
  })) {
    const existing = await lstat(directory).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("evaluation-profile-alias")
    await mkdir(directory, { recursive: true })
    environment[key] = directory
  }
  Object.assign(environment, input.providerEnvironment, kernelEnvironment, {
    ...(memoryStage ? { ZAOVRA_EVAL_MEMORY_HOST: memoryStage.environment } : {}),
    ZAOVRA_DB: path.join(input.profile, "sessions.sqlite"),
    ZAOVRA_DISABLE_MODELS_FETCH: "true",
    ZAOVRA_EXPERIMENTAL_EVENT_SYSTEM: "true",
    ZAOVRA_EXPERIMENTAL_WORKSPACES: "true",
  })
  if (input.kernelExperiment)
    await writeFile(
      path.join(input.stage, "kernel-experiment.json"),
      JSON.stringify({
        generation,
        ...input.kernelExperiment,
        environment: kernelEnvironment,
        evidence: "launch-input",
      }),
      { flag: "wx" },
    )
  const began = Date.now()
  await using owner = await openJob({
    directory: path.resolve(import.meta.dir, "../../../packages/zaovra"),
    log: path.join(input.stage, "backend.log"),
    command: [
      process.execPath,
      "run",
      "--no-env-file",
      "--no-install",
      `--config=${bunConfig}`,
      "script/memory-evaluation-backend.ts",
      readyFile,
      generation,
      ...(input.poison ? [fixtureFile] : []),
    ],
    seconds,
    environment,
  })
  const ready = await (async () => {
    while (Date.now() - began < Math.min(seconds * 1000, 15000)) {
      const file = Bun.file(readyFile)
      if (await file.exists()) {
        if (file.size > 4096) throw new Error("evaluation-ready-too-large")
        const value: unknown = await file.json()
        if (
          !record(value) ||
          value.generation !== generation ||
          value.pid !== owner.pid ||
          !loopback(value.api) ||
          !loopback(value.monitor)
        )
          throw new Error("evaluation-ready-identity-invalid")
        return { api: value.api, monitor: value.monitor }
      }
      if (!(await owner.inspect()).rootAlive) {
        const stopped = await owner.stop()
        await Bun.write(path.join(input.stage, "incomplete.json"), JSON.stringify({ generation, stopped }))
        throw new Error("evaluation-backend-ended-before-ready")
      }
      await Bun.sleep(50)
    }
    throw new Error("evaluation-backend-ready-timeout")
  })()
  const client = Zaovra.make({
    baseUrl: ready.api,
    headers: { "x-zaovra-directory": encodeURIComponent(input.directory) },
  })
  const signal = AbortSignal.timeout(Math.max(1, seconds * 1000 - (Date.now() - began)))
  const session = await client.sessions.create(
    { location: { directory: input.directory }, model: input.model },
    { signal },
  )
  const admitted = await client.sessions.prompt({ sessionID: session.id, prompt: { text: input.prompt } }, { signal })
  const admission = { sessionID: admitted.sessionID, id: admitted.id, admittedSeq: admitted.admittedSeq }
  const read = (capture?: CaptureBounds) =>
    observe({
      client,
      admission,
      attempts: 1,
      ...(capture ? { capture } : {}),
      async confirmBackground(check, requestSignal) {
        const before = await owner.inspect()
        backgroundReason = !before.rootAlive
          ? "root-ended"
          : before.members.length !== 1
            ? "other-job-members"
            : "checking-runtime"
        if (!before.rootAlive || before.members.length !== 1 || before.members[0] !== owner.pid) return "active"
        const response = await fetch(new URL("runtime", ready.monitor), { signal: requestSignal })
        if (!response.ok) return "unknown"
        const state: unknown = await response.json()
        backgroundReason =
          record(state) &&
          typeof state.reason === "string" &&
          ["idle-observed", "busy", "version-changed", "unavailable"].includes(state.reason)
            ? state.reason
            : "invalid-runtime-state"
        if (
          !record(state) ||
          state.generation !== generation ||
          state.pid !== owner.pid ||
          state.epoch !== check.epoch ||
          state.revision !== check.revision
        ) {
          backgroundReason = "runtime-identity-or-version-mismatch"
          return "unknown"
        }
        const after = await owner.inspect()
        if (!after.rootAlive || after.members.length !== 1 || after.members[0] !== owner.pid) return "active"
        return state.idle === true && state.reason === "idle-observed" ? "quiescent" : "active"
      },
    })
  let lastObservation: Awaited<ReturnType<typeof observe>> | undefined
  let backgroundReason = "not-observed"
  while (!signal.aborted) {
    const observed = await read()
    lastObservation = observed
    if (!observed.artifactReady || !observed.turn) {
      if (["own-assistant-terminated", "outcome-not-completed"].includes(observed.reason)) {
        // Failure diagnostics are not a completed turn or an artifact grading certificate.
        // Stop the owned backend before persisting the last bounded observation.
        const stopped = await owner.stop()
        await writeFile(
          path.join(input.stage, "incomplete.json"),
          JSON.stringify({ generation, admission, lastObservation, backgroundReason, stopped }),
          { flag: "wx" },
        )
        throw new Error("evaluation-session-not-completed")
      }
      await Bun.sleep(100)
      continue
    }
    const last = observed.evidence.at(-1)!
    const diagnostics = await collectHistory({ client, admission, cut: last.watermark })
    if (diagnostics.coverage.status !== "complete-through-cut") throw new Error("evaluation-history-incomplete")
    const final = await read(input.capture)
    const finalSnapshot = final.evidence.at(-1)
    if (
      !final.artifactReady ||
      !final.turn ||
      !finalSnapshot ||
      finalSnapshot.watermark !== last.watermark ||
      finalSnapshot.epoch !== last.epoch ||
      finalSnapshot.revision !== last.revision ||
      finalSnapshot.fingerprint !== last.fingerprint
    )
      continue
    const stopped = await owner.stop()
    // Only now can a separate oracle inspect the frozen workspace. This is not the oracle verdict.
    return { generation, admission, observation: final, diagnostics, stopped, elapsedMs: Date.now() - began }
  }
  await Bun.write(
    path.join(input.stage, "incomplete.json"),
    JSON.stringify({ generation, admission, lastObservation, backgroundReason }),
  )
  throw new Error("evaluation-session-deadline")
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function loopback(value: unknown): value is string {
  if (typeof value !== "string") return false
  const url = URL.canParse(value) ? new URL(value) : undefined
  return (
    url?.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Boolean(url.port) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  )
}
