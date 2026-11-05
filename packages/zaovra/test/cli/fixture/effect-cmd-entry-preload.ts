import { writeFileSync } from "node:fs"
import path from "node:path"
import { scheduler } from "node:timers/promises"
import { registerDisposer } from "../../../src/effect/instance-registry"

const directory = process.env.ZAOVRA_TEST_DISPOSER_DIR!
process.chdir(directory)
const events: string[] = []
const file = path.join(directory, "events.json")
const record = (name: string) => {
  events.push(name)
  writeFileSync(file, JSON.stringify(events))
}
setTimeout(() => process.exit(97), 20000).unref()
process.on("exit", () => record("process-exit"))
registerDisposer(async (current) => {
  if (path.resolve(current) !== path.resolve(directory)) return
  record("dispose-started")
  if (process.env.ZAOVRA_TEST_DISPOSER_SIGNAL === "event") process.emit("SIGTERM")
  await scheduler.wait(200)
  record("dispose-completed")
})
