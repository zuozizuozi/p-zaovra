import assert from "node:assert/strict"
import { readFile, writeFile, access, readdir, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { PreviewProcess } from "../src/preview-process"
import { AppProcess } from "../src/process"
import { LayerNode } from "../src/effect/layer-node"
import { ShellIdentity } from "../src/shell-identity"

const root = process.argv[2]
assert.ok(root, "A parent-owned temporary root is required")
// A backend normally keeps the event loop alive; this standalone fixture owns that lifetime.
const lifetime = setInterval(() => {}, 1000)
const owner = { root, directory: root, sessionID: "node-session", jobID: "node-preview" }
const ready = path.join(root, "ready.json")
const server = `const http=require('node:http');const fs=require('node:fs');const server=http.createServer((req,res)=>res.end('node-preview-alive'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({port:server.address().port})));`
let admitted!: () => void
const admission = new Promise<void>((resolve) => (admitted = resolve))
const completion = Effect.runPromise(
  PreviewProcess.run(
    ChildProcess.make(process.execPath, ["-e", server], { cwd: root, extendEnv: true }),
    owner,
    undefined,
    () => Effect.sync(admitted),
  ),
).then(
  (result) => ({ result }),
  (error: unknown) => ({ error }),
)
try {
  await Promise.race([
    admission,
    completion.then((result) => {
      throw new Error(`Preview ended before admission: ${JSON.stringify(result)}`)
    }),
  ])
  const deadline = Date.now() + 5000
  while (
    !(await access(ready).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() >= deadline) throw new Error("Node HTTP preview was not ready")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const service = JSON.parse(await readFile(ready, "utf8")) as { port: number }
  const observe = () => fetch(`http://127.0.0.1:${service.port}`, { signal: AbortSignal.timeout(1500) })
  assert.equal(await (await observe()).text(), "node-preview-alive")
  assert.equal((await PreviewProcess.get(owner))?.status, "running")
  await assert.rejects(PreviewProcess.cancel({ ...owner, sessionID: "another-session" }), /another Session/)
  const record = path.join(
    root,
    "preview-processes",
    (await readdir(path.join(root, "preview-processes")))[0],
    "owner.json",
  )
  const original = await readFile(record)
  try {
    await writeFile(record, JSON.stringify({ ...JSON.parse(original.toString()), birth: "stale-node-identity" }))
    assert.equal((await PreviewProcess.cancel(owner))?.status, "unavailable")
    assert.equal(await (await observe()).text(), "node-preview-alive")
  } finally {
    await writeFile(record, original)
  }
  if (process.platform === "linux") {
    const sentinel = path.join(root, "cancel-sentinel")
    const request = path.join(path.dirname(record), "cancel.request")
    await writeFile(sentinel, "must-not-change")
    await symlink(sentinel, request)
    try {
      await assert.rejects(PreviewProcess.cancel(owner), { code: "ELOOP" })
      assert.equal(await readFile(sentinel, "utf8"), "must-not-change")
      assert.equal(await (await observe()).text(), "node-preview-alive")
    } finally {
      await unlink(request)
    }
  }
  assert.equal((await PreviewProcess.cancel(owner))?.status, "cancelled")
  assert.equal(
    await observe().then(
      () => true,
      () => false,
    ),
    false,
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* AppProcess.Service
        const started = yield* Deferred.make<void>()
        const cancelledOwner = { ...owner, jobID: "cancelled-run" }
        const run = yield* service
          .run(
            ChildProcess.make(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, extendEnv: true }),
            {
              persistent: true,
              owner: cancelledOwner,
              onSpawn: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
            },
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
        yield* Effect.promise(() => PreviewProcess.cancel(cancelledOwner))
        const exit = yield* Fiber.await(run).pipe(Effect.timeout("1 second"))
        assert.equal(Exit.isFailure(exit), true)
        if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true, Cause.pretty(exit.cause))
      }),
    ).pipe(Effect.provide(LayerNode.compile(AppProcess.node))),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* AppProcess.Service
        const spawned = yield* Deferred.make<number>()
        const ready = yield* Deferred.make<void>()
        const notices: string[] = []
        const run = yield* service
          .run(
            ChildProcess.make(process.execPath, [
              "-e",
              "process.stdout.write('fallback-ready');setInterval(()=>{},1000)",
            ]),
            {
              persistent: true,
              combineOutput: true,
              owner: { ...owner, jobID: "platform-fallback" },
              onSpawn: (pid) => Deferred.succeed(spawned, pid).pipe(Effect.asVoid),
              onChunk: (chunk) =>
                Effect.gen(function* () {
                  notices.push(Buffer.from(chunk).toString())
                  if (Buffer.from(chunk).toString().includes("fallback-ready"))
                    yield* Deferred.succeed(ready, undefined)
                }),
            },
          )
          .pipe(Effect.forkChild)
        const pid = yield* Deferred.await(spawned)
        yield* Deferred.await(ready)
        assert.ok(yield* Effect.promise(() => PreviewProcess.birth(pid)))
        assert.match(notices.join(""), /backend-scoped.*survival across CLI exit is not guaranteed/)
        assert.equal(
          yield* Effect.promise(() => PreviewProcess.get({ ...owner, jobID: "platform-fallback" })),
          undefined,
        )
        yield* Fiber.interrupt(run)
        assert.equal(yield* Effect.promise(() => PreviewProcess.birth(pid)), undefined)
      }),
    ).pipe(
      Effect.provideService(AppProcess.PreviewPlatform, "darwin"),
      Effect.provide(LayerNode.compile(AppProcess.node)),
      Effect.timeout("5 seconds"),
    ),
  )
  const shells =
    process.platform === "win32"
      ? [
          { shell: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe"), cmd: true },
          { shell: ShellIdentity.gitBash(), cmd: false },
        ]
      : [{ shell: "/bin/sh", cmd: false }]
  await Effect.runPromise(
    Effect.scoped(
      AppProcess.Service.use((service) =>
        Effect.gen(function* () {
          for (const [index, item] of shells.entries()) {
            assert.ok(item.shell, "The selected shell must exist")
            const script = path.join(root, `selected-shell-${index}.cjs`)
            const ready = path.join(root, `selected-shell-${index}.ready`)
            yield* Effect.promise(() =>
              writeFile(
                script,
                `require('fs').writeFileSync(${JSON.stringify(ready)},'selected-shell-ok');setInterval(()=>{},1000)`,
              ),
            )
            const command = [process.execPath, script]
              .map((value) => (item.cmd ? `"${value}"` : `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`))
              .join(" ")
            const selectedOwner = { ...owner, jobID: `selected-shell-${index}` }
            const started = yield* Deferred.make<void>()
            const run = yield* service
              .run(ChildProcess.make(command, [], { shell: item.shell, cwd: root, extendEnv: true }), {
                persistent: true,
                owner: selectedOwner,
                timeout: "30 seconds",
                onSpawn: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
              })
              .pipe(Effect.forkChild)
            yield* Deferred.await(started)
            yield* Effect.promise(async () => {
              const deadline = Date.now() + 5000
              while ((await readFile(ready, "utf8").catch(() => "")) !== "selected-shell-ok") {
                if (Date.now() >= deadline) throw new Error("Selected shell did not start its preview command")
                await new Promise((resolve) => setTimeout(resolve, 20))
              }
            })
            assert.equal((yield* Effect.promise(() => PreviewProcess.get(selectedOwner)))?.status, "running")
            yield* Effect.promise(() => PreviewProcess.cancel(selectedOwner))
            const exit = yield* Fiber.await(run)
            assert.equal(Exit.isFailure(exit), true)
            if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true, Cause.pretty(exit.cause))
          }
        }),
      ),
    ).pipe(Effect.provide(LayerNode.compile(AppProcess.node))),
  )
  console.log(
    JSON.stringify({
      node: process.versions.node,
      launch: true,
      query: true,
      staleBirthRefused: true,
      otherSessionRefused: true,
      cancelled: true,
      businessClosed: true,
      unsupportedPlatform: "darwin",
      scopedFallbackStartedAndClosed: true,
      selectedShells: shells.length,
    }),
  )
} finally {
  await PreviewProcess.cancel(owner)
  // The product poll is unref'ed so normal CLI exit can leave previews alive.
  // This standalone fixture must keep its event loop alive until that poll settles.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settled = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Node preview drain did not settle after cancellation")), 5000)
      }),
    ])
    assert.equal("error" in settled, false)
  } finally {
    clearTimeout(timer)
    clearInterval(lifetime)
  }
}
