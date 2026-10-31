import { Deferred, Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ChildProcess } from "effect/unstable/process"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { AppProcess } from "@zaovra-ai/core/process"
import { BackgroundJob } from "@zaovra-ai/core/background-job"

const [kind, ready, protocol = "http", timeout, mode = "normal"] = process.argv.slice(2)
const persistent = kind === "service"
const script = fileURLToPath(new URL("./service-server.ts", import.meta.url))
const command =
  protocol === "daemon-shell"
    ? AppProcess.shellCommand(
        process.platform === "win32"
          ? `Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${script}" "${ready}" http' -WindowStyle Hidden`
          : `"${process.execPath}" "${script}" "${ready}" http &`,
        process.cwd(),
        process.platform === "win32" ? "powershell" : "bash",
      )
    : protocol === "shell"
      ? AppProcess.shellCommand(
          `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}" "${ready}" http`,
          process.cwd(),
          process.platform === "win32" ? "powershell" : "bash",
        )
      : ChildProcess.make(process.execPath, [script, ready, protocol], {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const app = yield* AppProcess.Service
      const jobs = yield* BackgroundJob.Service
      const registered = yield* Deferred.make<void>()
      yield* jobs.start({
        id: "owned-fixture",
        type: "bash",
        detached: persistent,
        run: app
          .run(command, {
            persistent,
            owner: {
              root: path.dirname(ready),
              jobID: "owned-fixture",
              sessionID: "fixture-session",
              directory: process.cwd(),
            },
            timeout: timeout ? Number(timeout) : undefined,
            onSpawn: () => Deferred.succeed(registered, undefined),
          })
          .pipe(
            Effect.tapError((error) => Effect.sync(() => console.error(error.cause))),
            Effect.as("done"),
          ),
      })
      yield* Effect.gen(function* () {
        const timer = Date.now() + 5000
        while (!(yield* Effect.promise(() => Bun.file(ready).exists()))) {
          const state = yield* jobs.get("owned-fixture")
          if (state?.status !== "running") return yield* Effect.die(state?.error ?? "Fixture launch failed")
          if (Date.now() > timer) return yield* Effect.die("Fixture service did not listen")
          yield* Effect.sleep(10)
        }
      })
      if (persistent) yield* Deferred.await(registered)
      yield* Effect.promise(() => Bun.write(ready + ".admitted", "admitted"))
      if (mode === "hold")
        yield* Effect.acquireUseRelease(
          Effect.sync(() => setInterval(() => {}, 1000)),
          () => Effect.never,
          (timer) => Effect.sync(() => clearInterval(timer)),
        )
    }),
  ).pipe(Effect.provide(LayerNode.compile(LayerNode.group([AppProcess.node, BackgroundJob.node])))),
)
