import path from "node:path"
import { connect } from "node:net"

const server = Bun.serve({
  hostname: process.env.ZAOVRA_FIXTURE_HOST ?? "127.0.0.1",
  port: Number(process.env.ZAOVRA_FIXTURE_PORT ?? 0),
  fetch: () => new Response("service-alive"),
})
const port = server.port!
if (process.argv[3] !== "git") {
  await Bun.write(process.argv[2], JSON.stringify({ pid: process.pid, port }))
}
if (process.argv[3] === "git") {
  server.stop(true)
  const root = path.dirname(process.argv[2])
  const repo = path.join(root, "repo.git")
  const init = Bun.spawnSync(["git", "init", "--bare", repo])
  if (init.exitCode !== 0) throw new Error(init.stderr.toString())
  const daemon = Bun.spawn(
    [
      "git",
      "daemon",
      "--export-all",
      "--reuseaddr",
      "--listen=127.0.0.1",
      `--port=${port}`,
      `--base-path=${root.replaceAll("\\", "/")}`,
      repo.replaceAll("\\", "/"),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  )
  const deadline = Date.now() + 5000
  while (true) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    if (listening) break
    if (Date.now() >= deadline) {
      daemon.kill()
      await daemon.exited
      throw new Error("Git daemon did not listen")
    }
    await Bun.sleep(10)
  }
  await Bun.write(process.argv[2], JSON.stringify({ pid: process.pid, childPid: daemon.pid, port }))
  await daemon.exited
}
