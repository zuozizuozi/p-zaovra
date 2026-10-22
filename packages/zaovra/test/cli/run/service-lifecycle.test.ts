import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { createZaovraClient } from "@zaovra-ai/sdk/v2"

// Observe a real business endpoint in a separate process, after the CLI has
// exited. A health check against Zaovra itself cannot establish service life.
for (const owner of ["local", "attach", "desktop"] as const) {
  if (owner === "desktop" && !process.env.ZAOVRA_LIFECYCLE_BUILD) {
    test.skip("331 desktop lifecycle requires the isolated Electron fixture build", () => {})
    continue
  }
  cliIt.live(
    `331 business service after normal ${owner} CLI exit and exact owner cleanup`,
    ({ home, llm, zaovra }) =>
      Effect.gen(function* () {
        const nonce = crypto.randomUUID()
        const identity = path.join(home, "business.json")
        const script = path.join(home, "business.cjs")
        yield* Effect.promise(() =>
          Bun.write(
            script,
            `
const http = require("node:http");
const fs = require("node:fs");
const nonce = ${JSON.stringify(nonce)};
const server = http.createServer((request, response) => {
  if (request.url === "/shutdown/" + nonce && request.method === "POST") { response.end("stopped"); server.close(() => process.exit(0)); return; }
  if (request.url !== "/business") { response.writeHead(404).end(); return; }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ nonce, pid: process.pid, value: 42 }));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(identity)}, JSON.stringify({ nonce, pid: process.pid, url: "http://127.0.0.1:" + server.address().port + "/business" })));
`,
          ),
        )
        const config = { ...testProviderConfig(llm.url), snapshot: false, experimental: { verification: false } }
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (!(await Bun.file(identity).exists())) return
            const record = await Bun.file(identity).json()
            if (record.nonce !== nonce) return
            const response = await fetch(record.url, { signal: AbortSignal.timeout(1000) })
              .then((r) => r.json())
              .catch(() => undefined)
            if (response?.nonce !== nonce || response?.pid !== record.pid) return
            await fetch(new URL(`/shutdown/${nonce}`, record.url), {
              method: "POST",
              signal: AbortSignal.timeout(1000),
            }).catch(() => undefined)
          }),
        )
        const server =
          owner === "attach"
            ? yield* zaovra.serve({ env: { ZAOVRA_CONFIG_CONTENT: JSON.stringify(config) } })
            : owner === "desktop"
              ? yield* desktopOwner(home, JSON.stringify(config))
              : undefined
        const client = server
          ? createZaovraClient({
              baseUrl: server.url,
              directory: home,
              ...(owner === "desktop"
                ? { headers: { authorization: `Basic ${Buffer.from("zaovra:fixture").toString("base64")}` } }
                : {}),
            })
          : undefined
        const session = client
          ? yield* Effect.promise(() =>
              client.v2.session
                .create({ location: { directory: home } }, { throwOnError: true })
                .then((r) => r.data.data),
            )
          : undefined
        yield* llm.push(
          reply().tool("bash", {
            command: `node "${script}"`,
            description: "Start the fixture business service",
            run_in_background: true,
            background_kind: "preview",
          }),
          reply().text("Service started; lifecycle remains unverified.").stop(),
        )
        const result = yield* zaovra.run("Start the business service", {
          format: "json",
          extraArgs: [
            "--dangerously-skip-permissions",
            ...(server && session ? ["--attach", server.url, "--session", session.id] : []),
          ],
          env: {
            ZAOVRA_CONFIG_CONTENT: JSON.stringify(config),
            ...(owner === "desktop" ? { ZAOVRA_SERVER_PASSWORD: "fixture" } : {}),
          },
        })
        zaovra.expectExit(result, 0)
        expect(yield* llm.calls).toBe(2)
        const record = yield* Effect.promise(() => Bun.file(identity).json())
        expect(record.nonce).toBe(nonce)
        const observe = () =>
          Effect.promise(async () => {
            const child = Bun.spawn(
              [
                process.execPath,
                "-e",
                `fetch(process.argv[1], {signal: AbortSignal.timeout(1500)}).then(async r => {if (!r.ok) throw Error("HTTP " + r.status); console.log(await r.text())}).catch(() => process.exit(3))`,
                record.url,
              ],
              { stdout: "pipe", stderr: "pipe" },
            )
            const stdout = new Response(child.stdout).text()
            const stderr = new Response(child.stderr).text()
            return { exit: await child.exited, stdout: await stdout, stderr: await stderr }
          })
        const afterCli = yield* observe()
        expect(afterCli.exit).toBe(owner === "local" ? 3 : 0)
        if (owner === "local") return
        expect(JSON.parse(afterCli.stdout)).toEqual({ nonce, pid: record.pid, value: 42 })
        // Archiving this exact Session closes its previews. Never kill by
        // process name, port or a command-line pattern.
        yield* Effect.promise(() =>
          client!.v2.session.update({ sessionID: session!.id, archived: true }, { throwOnError: true }),
        )
        const afterCleanup = yield* observe()
        expect(afterCleanup.exit).toBe(3)
        if (owner === "desktop" && server && "stop" in server) {
          yield* server.stop
          expect((yield* observe()).exit).toBe(3)
        }
      }),
    120_000,
  )
}

const desktopOwner = Effect.fn("lifecycle.desktopOwner")(function* (home: string, config: string) {
  const build = process.env.ZAOVRA_LIFECYCLE_BUILD!
  yield* Effect.promise(() =>
    Bun.write(path.join(build, "package.json"), JSON.stringify({ main: "owner.js", type: "module" })),
  )
  const ready = path.join(home, "desktop-ready.json")
  const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const selected = port.port
  port.stop(true)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(
        [path.resolve(import.meta.dirname, "../../../../desktop-app/node_modules/electron/dist/electron.exe"), build],
        {
          cwd: home,
          env: {
            ...env,
            HOME: home,
            USERPROFILE: home,
            ZAOVRA_TEST_HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            XDG_DATA_HOME: path.join(home, "data"),
            XDG_CACHE_HOME: path.join(home, "cache"),
            XDG_STATE_HOME: path.join(home, "state"),
            ZAOVRA_CONFIG_CONTENT: config,
            ZAOVRA_AUTH_CONTENT: "{}",
            ZAOVRA_PURE: "1",
            ZAOVRA_DISABLE_PROJECT_CONFIG: "1",
            ZAOVRA_DISABLE_MODELS_FETCH: "1",
            ZAOVRA_DISABLE_CHANNEL_DB: "1",
            ZAOVRA_LIFECYCLE_HOME: home,
            ZAOVRA_LIFECYCLE_PORT: String(selected),
            ZAOVRA_LIFECYCLE_READY: ready,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      ),
    ),
    (proc) =>
      Effect.promise(async () => {
        if (proc.exitCode !== null) return
        await Bun.write(ready + ".stop", "stop")
        await Promise.race([proc.exited, new Promise<void>((resolve) => setTimeout(resolve, 8000))])
        if (proc.exitCode === null) proc.kill()
        await proc.exited
      }).pipe(Effect.ignore),
  )
  const stdout = new Response(child.stdout).text()
  const errors: string[] = []
  const stderr = (async () => {
    for await (const chunk of child.stderr) {
      errors.push(Buffer.from(chunk).toString())
    }
    return errors.join("")
  })()
  const until = Date.now() + 25_000
  while (!(yield* Effect.promise(() => Bun.file(ready).exists()))) {
    if (child.exitCode !== null) {
      const logs = yield* Effect.promise(() => Promise.all([stderr, stdout]))
      throw new Error(`Desktop owner exited ${child.exitCode}: ${logs.join("\n")}`)
    }
    if (Date.now() >= until) {
      const stage = yield* Effect.promise(() =>
        Bun.file(ready + ".stage")
          .text()
          .catch(() => "owner not loaded"),
      )
      throw new Error(`Desktop owner readiness timed out (${stage}): ${errors.join("")}`)
    }
    yield* Effect.sleep("100 millis")
  }
  return {
    url: `http://127.0.0.1:${selected}`,
    stop: Effect.promise(async () => {
      await Bun.write(ready + ".stop", "stop")
      expect(await child.exited).toBe(0)
      await stdout
      await stderr
    }),
  }
})
