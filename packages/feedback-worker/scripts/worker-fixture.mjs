import { unstable_dev } from "wrangler"
import { writeFile, readFile, rename } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
const root = process.env.ZAOVRA_WORKER_TEST_DIR
if (!root) throw new Error("Missing isolated fixture directory")
const birth =
  process.platform === "win32"
    ? (
        await promisify(execFile)(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Process -Id " + process.pid + ").StartTime.ToUniversalTime().ToString('o')",
          ],
          { windowsHide: true },
        )
      ).stdout.trim()
    : (await readFile("/proc/self/stat", "utf8")).split(") ").slice(1).join(") ").split(/\s+/)[19]
if (!birth) throw new Error("Missing owned fixture process birth")
await writeFile(root + "/runtime-process.json", JSON.stringify({ pid: process.pid, birth }))
const stopped = new Promise((resolve) => process.stdin.once("end", resolve))
process.stdin.resume()
const worker = await unstable_dev("src/index.ts", {
  config: "wrangler.jsonc",
  ip: "127.0.0.1",
  port: 0,
  local: true,
  inspect: false,
  persistTo: root + "/state",
  logLevel: "error",
  vars: {
    ACCESS_TEAM_DOMAIN: process.argv[2],
    ACCESS_AUD: "local-fixture",
    FEEDBACK_NOTIFY_FROM: "worker@example.invalid",
    FEEDBACK_NOTIFY_TO: "recipient@example.invalid",
  },
  experimental: { forceLocal: true, watch: false, disableDevRegistry: true, enableContainers: false },
})
await writeFile(
  root + "/runtime-ready.json.tmp",
  JSON.stringify({ pid: process.pid, birth, base: "http://" + worker.address + ":" + worker.port }),
)
await rename(root + "/runtime-ready.json.tmp", root + "/runtime-ready.json")
await stopped
await worker.stop()
await writeFile(
  root + "/runtime-stopped.json",
  JSON.stringify({ pid: process.pid, birth, managed_worker_stop_resolved: true, manual_PID_signals: 0 }),
)
