import { app } from "electron"
import { spawnLocalServer } from "../../src/main/server"
import { existsSync, writeFileSync } from "node:fs"

// No window: exercise the actual Electron utility-process owner and sidecar.
writeFileSync(process.env.ZAOVRA_LIFECYCLE_READY! + ".stage", "owner-loaded")
app.setPath("userData", process.env.ZAOVRA_LIFECYCLE_HOME!)
app.setPath("crashDumps", process.env.ZAOVRA_LIFECYCLE_HOME!)
void app
  .whenReady()
  .then(async () => {
    writeFileSync(process.env.ZAOVRA_LIFECYCLE_READY! + ".stage", "electron-ready")
    const server = await spawnLocalServer("127.0.0.1", Number(process.env.ZAOVRA_LIFECYCLE_PORT), "fixture", {
      userDataPath: process.env.ZAOVRA_LIFECYCLE_HOME!,
      onStderr: (message) => console.error(message),
    })
    writeFileSync(process.env.ZAOVRA_LIFECYCLE_READY!, JSON.stringify({ pid: process.pid }))
    const until = Date.now() + 60_000
    const timer = setInterval(async () => {
      if (!existsSync(process.env.ZAOVRA_LIFECYCLE_READY! + ".stop") && Date.now() < until) return
      clearInterval(timer)
      await server.listener.stop()
      app.exit(0)
    }, 100)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
