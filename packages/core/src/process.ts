import { Context, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import { ShellIdentity } from "./shell-identity"
import { randomUUID } from "node:crypto"
import { makeGlobalNode } from "./effect/app-node"

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()("AppProcessError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  outputTruncated: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
  reason: Schema.optional(
    Schema.Literals([
      "shell-unavailable",
      "command-not-found",
      "syntax-incompatible",
      "timeout",
      "cancelled",
      "non-zero-exit",
    ]),
  ),
}) {
  override get message() {
    const detail =
      this.stderr?.trim() || (this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause))
    const status = this.exitCode === undefined ? "" : ` (exit ${this.exitCode})`
    return `Command failed${status}: ${this.command}${detail ? `: ${detail}` : ""}`
  }
}

export interface RunOptions {
  readonly combineOutput?: boolean
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  /** Receives combined-output snapshots, bounded by maxOutputBytes when set. */
  readonly onOutput?: (output: Buffer, truncated: boolean) => Effect.Effect<void>
  /** Receives every combined-output chunk before the in-memory preview is bounded. */
  readonly onChunk?: (chunk: Uint8Array) => Effect.Effect<void, unknown>
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
}

export interface RunStreamOptions {
  readonly signal?: AbortSignal
  readonly includeStderr?: boolean
  readonly okExitCodes?: ReadonlyArray<number>
  readonly maxErrorBytes?: number
}

export interface RunResult {
  readonly reason?: "command-not-found" | "syntax-incompatible" | "non-zero-exit"
  readonly command: string
  readonly exitCode: number
  readonly output?: Buffer
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly outputTruncated?: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type Interface = ChildProcessSpawner["Service"] & {
  readonly run: (command: ChildProcess.Command, options?: RunOptions) => Effect.Effect<RunResult, AppProcessError>
  readonly runStream: (
    command: ChildProcess.Command,
    options?: RunStreamOptions,
  ) => Stream.Stream<string, AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/AppProcess") {}

/** Shared shell process lifecycle; callers retain their own authorization and output policy. */
export const resolveShell = (configured?: string) => {
  return ShellIdentity.resolve(configured).path
}

export const shellCommand = (command: string, cwd: string, shell?: string) => {
  const executable = resolveShell(shell)
  const powershell = /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)
  if (powershell) {
    // Pass one script argument directly, as Codex does; no cmd.exe or extra shell parses it.
    // Out-Default drains PowerShell's deferred table formatter before our explicit exit.
    // Capture command failure before that output pipeline can replace $?.
    const marker = `ZAOVRA_SHELL_${randomUUID().replaceAll("-", "")}:`
    const body = Buffer.from(`${command}\nif (-not $? -and $LASTEXITCODE -eq 0) { $global:LASTEXITCODE = 1 }`).toString(
      "base64",
    )
    const script = `# ${marker}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $ProgressPreference = 'SilentlyContinue'; $global:LASTEXITCODE = 0; $Error.Clear();
try { $zaovraScript = [scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${body}'))) } catch { [Console]::Error.WriteLine($_.ToString()); [Console]::Error.WriteLine('${marker}syntax-incompatible'); exit 1 }
& {
& $zaovraScript
if (-not $? -and $LASTEXITCODE -eq 0) { $global:LASTEXITCODE = 1 } } | Out-Default; if (-not $? -and $LASTEXITCODE -eq 0) { exit 1 }; exit $LASTEXITCODE`
    const diagnosed = script.replace(
      "exit $LASTEXITCODE",
      `if ($LASTEXITCODE -ne 0 -and $Error.Count -gt 0 -and $Error[0].CategoryInfo.Category -eq 'ObjectNotFound' -and $Error[0].Exception -is [System.Management.Automation.CommandNotFoundException]) { [Console]::Error.WriteLine('${marker}command-not-found') }; exit $LASTEXITCODE`,
    )
    return ChildProcess.make(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", diagnosed], {
      cwd,
      stdin: "ignore",
      detached: process.platform !== "win32",
      forceKillAfter: Duration.seconds(3),
    })
  }
  return ChildProcess.make(command, [], {
    cwd,
    shell: executable,
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: Duration.seconds(3),
  })
}

export const requireSuccess = (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new AppProcessError({
          command: result.command,
          exitCode: result.exitCode,
          stderr: result.stderr.toString("utf8"),
        }),
      )

export const requireExitIn =
  (codes: ReadonlyArray<number>) =>
  (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
    codes.includes(result.exitCode)
      ? Effect.succeed(result)
      : Effect.fail(
          new AppProcessError({
            command: result.command,
            exitCode: result.exitCode,
            stderr: result.stderr.toString("utf8"),
          }),
        )

const describeCommand = (command: ChildProcess.Command): string => {
  if (command._tag === "StandardCommand") {
    return command.args.length ? `${command.command} ${command.args.join(" ")}` : command.command
  }
  return `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

function failureReason(command: ChildProcess.Command, output: Buffer, code: number): RunResult["reason"] {
  if (code === 0) return
  const marker =
    command._tag === "StandardCommand" ? command.args.at(-1)?.match(/^# (ZAOVRA_SHELL_[a-f0-9]+:)/)?.[1] : undefined
  if (marker && output.includes(`${marker}syntax-incompatible`)) return "syntax-incompatible"
  if (marker && output.includes(`${marker}command-not-found`)) return "command-not-found"
  // A shell may have executed earlier statements. Classification is not a claim of non-execution.
  return "non-zero-exit"
}

const wrapError = (description: string, cause: unknown): AppProcessError =>
  cause instanceof AppProcessError
    ? cause
    : new AppProcessError({
        command: description,
        cause,
        ...(cause instanceof Error && cause.name === "AbortError" ? { reason: "cancelled" as const } : {}),
      })

export const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError(signal)))
      return
    }
    const onabort = () => resume(Effect.fail(abortError(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })

const normalizeStdin = (
  input: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<Uint8Array, PlatformError> =>
  typeof input === "string"
    ? Stream.make(new TextEncoder().encode(input))
    : input instanceof Uint8Array
      ? Stream.make(input)
      : input

export const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError>, maxOutputBytes: number | undefined) =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
    (acc, chunk) => {
      if (maxOutputBytes === undefined) {
        acc.chunks.push(chunk)
        acc.bytes += chunk.length
        return acc
      }
      const remaining = maxOutputBytes - acc.bytes
      if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
      acc.bytes += chunk.length
      acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
      return acc
    },
  ).pipe(
    Effect.map((x) => ({
      buffer: x.truncated ? utf8Prefix(Buffer.concat(x.chunks)) : Buffer.concat(x.chunks),
      truncated: x.truncated,
    })),
  )

/** Drop only an incomplete trailing character at a byte limit. */
export const utf8Prefix = (bytes: Uint8Array) => Buffer.from(new TextDecoder().decode(bytes, { stream: true }))

export const utf8Tail = (bytes: Uint8Array) => {
  const start = bytes.findIndex((byte) => (byte & 0xc0) !== 0x80)
  return start < 0 ? Buffer.alloc(0) : Buffer.from(bytes.subarray(start))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const runCommand = (command: ChildProcess.Command, options?: RunOptions) =>
      Effect.suspend(() => {
        const description = describeCommand(command)
        if (
          command._tag === "StandardCommand" &&
          typeof command.options.shell === "string" &&
          /(?:^|[\\/])cmd(?:\.exe)?$/i.test(command.options.shell) &&
          /[\r\n]/.test(command.command)
        )
          return Effect.fail(
            new AppProcessError({
              command: description,
              reason: "syntax-incompatible",
              cause: new Error(
                "cmd cannot reliably execute multiline command strings. No command was executed. Write a .cmd or language script file and invoke it with a single-line command, or configure PowerShell.",
              ),
            }),
          )
        if (options?.signal?.aborted)
          return Effect.fail(
            new AppProcessError({ command: description, cause: abortError(options.signal), reason: "cancelled" }),
          )
        let captured = Buffer.alloc(0)
        let truncated = false
        const collect = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(command)
            if (options?.combineOutput) {
              const [output, exitCode] = yield* Effect.all(
                [
                  Stream.merge(handle.stdout.pipe(Stream.decodeText), handle.stderr.pipe(Stream.decodeText))
                    .pipe(Stream.map((text) => Buffer.from(text)))
                    .pipe(
                      Stream.runForEach((chunk) =>
                        Effect.gen(function* () {
                          if (options.onChunk) yield* options.onChunk(chunk)
                          const next = Buffer.concat([captured, chunk])
                          const maximum = options.maxOutputBytes
                          const overflow = maximum !== undefined && next.length > maximum
                          truncated ||= overflow
                          captured = overflow
                            ? Buffer.concat([
                                utf8Prefix(next.subarray(0, Math.ceil(maximum / 2))),
                                utf8Tail(next.subarray(next.length - Math.floor(maximum / 2))),
                              ])
                            : next
                          if (options.onOutput) yield* options.onOutput(captured, truncated)
                        }),
                      ),
                    )
                    .pipe(Effect.map(() => ({ buffer: captured, truncated }))),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              )
              return {
                command: description,
                exitCode,
                output: output.buffer,
                reason: failureReason(command, output.buffer, exitCode),
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                outputTruncated: output.truncated,
                stdoutTruncated: false,
                stderrTruncated: false,
              } satisfies RunResult
            }
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                collectStream(handle.stdout, options?.maxOutputBytes),
                collectStream(handle.stderr, options?.maxErrorBytes),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            )
            return {
              command: description,
              exitCode,
              stdout: stdout.buffer,
              reason: failureReason(command, stderr.buffer, exitCode),
              stderr: stderr.buffer,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            } satisfies RunResult
          }),
        )
        const timed = options?.timeout
          ? Effect.timeoutOrElse(collect, {
              duration: options.timeout,
              orElse: () =>
                Effect.fail(
                  new AppProcessError({
                    command: description,
                    cause: new Error("Timed out"),
                    reason: "timeout",
                    ...(options.combineOutput ? { output: captured.toString("utf8"), outputTruncated: truncated } : {}),
                  }),
                ),
            })
          : collect
        const aborted = options?.signal
          ? timed.pipe(
              Effect.raceFirst(
                waitForAbort(options.signal).pipe(
                  Effect.mapError((cause) => new AppProcessError({ command: description, cause, reason: "cancelled" })),
                ),
              ),
            )
          : timed
        return aborted.pipe(Effect.catch((cause) => Effect.fail(wrapError(description, cause))))
      })

    const run = Effect.fn("AppProcess.run")(function* (command: ChildProcess.Command, options?: RunOptions) {
      if (options?.stdin === undefined) return yield* runCommand(command, options)
      if (command._tag !== "StandardCommand") {
        return yield* new AppProcessError({
          command: describeCommand(command),
          cause: new Error("stdin option only supports StandardCommand; received PipedCommand"),
        })
      }
      const next = ChildProcess.make(command.command, command.args, {
        ...command.options,
        stdin: normalizeStdin(options.stdin),
      })
      return yield* runCommand(next, options)
    })

    const runStream = (
      command: ChildProcess.Command,
      options?: RunStreamOptions,
    ): Stream.Stream<string, AppProcessError> => {
      const description = describeCommand(command)
      const okExitCodes = options?.okExitCodes
      const built: Stream.Stream<string, AppProcessError | PlatformError> = Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command)
          let capturedError = Buffer.alloc(0)
          const stderrFiber = options?.includeStderr
            ? undefined
            : yield* Effect.forkScoped(
                collectStream(handle.stderr, options?.maxErrorBytes).pipe(Effect.map((x) => x.buffer.toString("utf8"))),
              )
          const source =
            options?.includeStderr === true
              ? Stream.merge(
                  handle.stdout.pipe(Stream.decodeText),
                  handle.stderr.pipe(
                    Stream.decodeText,
                    Stream.tap((text) =>
                      Effect.sync(() => {
                        const bytes = Buffer.concat([capturedError, Buffer.from(text)])
                        capturedError =
                          options?.maxErrorBytes === undefined
                            ? bytes
                            : utf8Prefix(bytes.subarray(0, options.maxErrorBytes))
                      }),
                    ),
                  ),
                )
              : handle.stdout.pipe(Stream.decodeText)
          const lines = source.pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
          )
          const tail = Stream.unwrap(
            Effect.gen(function* () {
              const code = yield* handle.exitCode
              if (okExitCodes && okExitCodes.length > 0 && !okExitCodes.includes(code)) {
                const stderr = stderrFiber ? yield* Fiber.join(stderrFiber) : capturedError.toString("utf8")
                return Stream.fail(new AppProcessError({ command: description, exitCode: code, stderr }))
              }
              return Stream.empty
            }),
          )
          return Stream.concat(lines, tail) as Stream.Stream<string, AppProcessError | PlatformError>
        }),
      )
      const mapped = built.pipe(
        Stream.catch((cause): Stream.Stream<string, AppProcessError> => Stream.fail(wrapError(description, cause))),
      )
      if (!options?.signal) return mapped
      const signal = options.signal
      return mapped.pipe(
        Stream.interruptWhen(waitForAbort(signal).pipe(Effect.mapError((cause) => wrapError(description, cause)))),
      )
    }

    return Service.of({ ...spawner, run, runStream })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [CrossSpawnSpawner.node] })

export * as AppProcess from "./process"
