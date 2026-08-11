import { Work } from "@zaovra-ai/core/work"
import { Effect, Schema } from "effect"
import os from "os"
import { effectCmd, fail } from "../effect-cmd"

const EnrollmentResponse = Schema.Struct({ data: Work.WorkerEnrollment })

const connectionOptions = <T>(yargs: import("yargs").Argv<T>) =>
  yargs
    .option("controller", {
      type: "string",
      default: "http://127.0.0.1:4096",
      describe: "ZAOVRA controller URL",
    })
    .option("username", {
      type: "string",
      default: process.env.ZAOVRA_CONTROLLER_USERNAME ?? "zaovra",
      describe: "controller username when server authentication is enabled",
    })
    .option("password", {
      type: "string",
      default: process.env.ZAOVRA_CONTROLLER_PASSWORD,
      describe: "controller password when server authentication is enabled",
    })

const registrationOptions = <T>(yargs: import("yargs").Argv<T>) =>
  yargs
    .option("label", {
      type: "string",
      default: os.hostname(),
      describe: "Worker label shown in the IDE",
    })
    .option("endpoint", {
      type: "string",
      describe: "optional operator-visible Worker endpoint",
    })
    .option("capability", {
      type: "string",
      array: true,
      choices: ["execute", "worktree", "mcp"] as const,
      default: ["execute", "worktree", "mcp"] as const,
      describe: "Worker capability",
    })
    .option("workspace-root", {
      type: "string",
      array: true,
      default: [process.cwd()],
      describe: "workspace root accessible to this Worker",
    })
    .option("max-jobs", {
      type: "number",
      default: 1,
      describe: "maximum concurrent remote Jobs (1-32)",
    })

const EnrollCommand = effectCmd({
  command: "enroll",
  describe: "enroll a Worker and issue a one-time credential",
  instance: false,
  builder: (yargs) =>
    registrationOptions(connectionOptions(yargs))
      .option("mode", {
        type: "string",
        choices: ["shared", "remote"] as const,
        default: "remote" as const,
        describe: "shared database runtime or remote fenced Job executor",
      })
      .option("map", {
        type: "string",
        array: true,
        default: [] as string[],
        describe: "Location mapping in controllerRoot=workerRoot form (remote mode)",
      }),
  handler: Effect.fn("Cli.worker.enroll")(function* (args) {
    const mappings = args.map
      .map((value: string) => parseMapping(value))
      .filter((mapping: Work.WorkerLocationMapping | undefined) => mapping !== undefined)
    if (mappings.length !== args.map.length) yield* fail("Every --map must use controllerRoot=workerRoot form")
    if (args.mode === "remote" && mappings.length === 0)
      yield* fail("Remote Worker enrollment requires at least one --map controllerRoot=workerRoot")
    if (!Number.isInteger(args.maxJobs) || args.maxJobs < 1 || args.maxJobs > 32)
      yield* fail("--max-jobs must be an integer between 1 and 32")
    if (!secureController(args.controller)) yield* fail("Worker controllers must use HTTPS outside localhost")
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${args.controller.replace(/\/$/, "")}/api/work/workers/enroll`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(args.password
              ? { authorization: `Basic ${Buffer.from(`${args.username}:${args.password}`).toString("base64")}` }
              : {}),
          },
          body: JSON.stringify({
            label: args.label,
            endpoint: args.endpoint,
            capabilities: args.capability,
            workspaceRoots: args.workspaceRoot,
            capacity: args.maxJobs,
            executionMode: args.mode,
            locationMappings: mappings,
          }),
        }),
      catch: (error) => new Error(`Worker enrollment failed: ${String(error)}`),
    }).pipe(Effect.catch((error) => fail(error.message)))
    if (!response.ok)
      yield* fail(
        `Worker enrollment failed (${response.status}): ${(yield* Effect.promise(() => response.text())).slice(0, 1_000)}`,
      )
    const enrollment = yield* Schema.decodeUnknownEffect(EnrollmentResponse)(
      yield* Effect.promise(() => response.json()),
    ).pipe(
      Effect.map((value) => value.data),
      Effect.mapError((error) => new Error(`Controller returned an invalid enrollment: ${error.message}`)),
      Effect.catch((error) => fail(error.message)),
    )
    console.log(`Worker ID: ${enrollment.worker.id}`)
    console.log(`Worker token: ${enrollment.token}`)
    console.log(`Worker mode: ${enrollment.worker.executionMode}`)
    console.log("The token is shown once. Store it securely before starting the Worker.")
  }),
})

const StartCommand = effectCmd({
  command: "start",
  describe: "run an authenticated WorkGraph Worker process",
  instance: false,
  builder: (yargs) =>
    registrationOptions(connectionOptions(yargs))
      .option("id", {
        type: "string",
        demandOption: true,
        describe: "enrolled Worker ID",
      })
      .option("token", {
        type: "string",
        default: process.env.ZAOVRA_WORKER_TOKEN,
        describe: "Worker token, or set ZAOVRA_WORKER_TOKEN",
      })
      .option("database", {
        type: "string",
        default: process.env.ZAOVRA_DB,
        describe: "shared controller SQLite database path",
      })
      .option("mode", {
        type: "string",
        choices: ["shared", "remote"] as const,
        describe: "defaults to shared when --database is set, otherwise remote",
      }),
  handler: Effect.fn("Cli.worker.start")(function* (args) {
    if (!args.token) yield* fail("Worker token is required; pass --token or set ZAOVRA_WORKER_TOKEN")
    if (!Schema.is(Work.WorkerID)(args.id)) yield* fail(`Invalid Worker ID: ${args.id}`)
    const mode = args.mode ?? (args.database ? "shared" : "remote")
    if (!Number.isInteger(args.maxJobs) || args.maxJobs < 1 || args.maxJobs > 32)
      yield* fail("--max-jobs must be an integer between 1 and 32")
    console.log(`ZAOVRA Worker ${args.id} (${mode}) polling ${args.controller}`)
    const { WorkWorkerRuntime } = yield* Effect.promise(() => import("../../worker/runtime"))
    yield* WorkWorkerRuntime.run({
      controller: args.controller,
      workerID: args.id,
      runtimeID: Work.WorkerRuntimeID.create(),
      token: args.token,
      mode,
      database: args.database,
      username: args.username,
      password: args.password,
      label: args.label,
      endpoint: args.endpoint,
      capabilities: args.capability,
      workspaceRoots: args.workspaceRoot,
      capacity: args.maxJobs,
    }).pipe(Effect.catch((error) => fail(error.message)))
  }),
})

export const WorkerCommand = effectCmd({
  command: "worker",
  describe: "manage durable WorkGraph Worker processes",
  instance: false,
  builder: (yargs) => yargs.command(EnrollCommand).command(StartCommand).demandCommand(),
  handler: Effect.fn("Cli.worker")(function* () {}),
})

function parseMapping(value: string): Work.WorkerLocationMapping | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0 || separator === value.length - 1) return undefined
  const controllerRoot = value.slice(0, separator).trim()
  const workerRoot = value.slice(separator + 1).trim()
  if (!controllerRoot || !workerRoot) return undefined
  return Work.WorkerLocationMapping.make({ controllerRoot, workerRoot })
}

function secureController(value: string) {
  const url = URL.parse(value)
  if (!url) return false
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
}
