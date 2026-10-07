import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()
const start = source.indexOf('  if (!app.isPackaged && !app.commandLine.hasSwitch("remote-debugging-port"))')
const end = source.indexOf("  if (!app.requestSingleInstanceLock())", start)
if (start < 0 || end < start) throw new Error("Development debug-port startup block not found")
const startup = source.slice(start, end)

for (const input of [
  { packaged: false, port: undefined, expected: "9222" },
  { packaged: false, port: "0", expected: "0" },
  { packaged: false, port: "5345", expected: "5345" },
  { packaged: true, port: undefined, expected: undefined },
  { packaged: true, port: "0", expected: "0" },
]) {
  test(`debug port: packaged=${input.packaged}, explicit=${input.port ?? "none"}`, () => {
    const switches = new Map<string, string>(input.port === undefined ? [] : [["remote-debugging-port", input.port]])
    runInNewContext(startup, {
      app: {
        isPackaged: input.packaged,
        commandLine: {
          hasSwitch: (name: string) => switches.has(name),
          appendSwitch: (name: string, value: string) => switches.set(name, value),
        },
      },
    })
    expect(switches.get("remote-debugging-port")).toBe(input.expected)
  })
}
