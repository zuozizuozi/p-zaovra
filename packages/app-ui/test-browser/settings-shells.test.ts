import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSettingsShells } from "../src/utils/settings-shells"

test("effective shell follows project scope, ignores late replies and reports failures", async () => {
  const a = Promise.withResolvers<string[]>()
  const b = Promise.withResolvers<string[]>()
  const calls: string[] = []
  const [directory, setDirectory] = createSignal<string | undefined>("/a")
  let dispose = () => {}
  const [shells] = createRoot((cleanup) => {
    dispose = cleanup
    return createSettingsShells(() => ({
      directory: directory(),
      read: (path) => {
        calls.push(path)
        if (path === "/a") return a.promise
        if (path === "/b") return b.promise
        return Promise.reject(new Error("offline"))
      },
    }), () => "query failed")
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    setDirectory("/b")
    b.resolve(["shell-b"])
    await flush()
    a.resolve(["shell-a"])
    await flush()
    expect(shells().items).toEqual(["shell-b"])
    expect(calls).toEqual(["/a", "/b"])
    setDirectory("/error")
    await flush()
    expect(shells().error).toBe("query failed")
    expect(shells().items).toEqual([])
    setDirectory(undefined)
    await flush()
    expect(calls).toEqual(["/a", "/b", "/error"])
    expect(shells().error).toBeUndefined()
  } finally {
    dispose()
  }
})

test("same directory follows server and configured shell changes without stale errors", async () => {
  const old = Promise.withResolvers<string[]>()
  const [server, setServer] = createSignal("old")
  const [configured, setConfigured] = createSignal("auto")
  const calls: string[] = []
  let dispose = () => {}
  const [shells] = createRoot((cleanup) => {
    dispose = cleanup
    return createSettingsShells(() => {
      const selected = server()
      const shell = configured()
      return {
        directory: "/same",
        configured: shell,
        read: (directory: string) => {
          calls.push(`${selected}:${directory}:${shell}`)
          return selected === "old" ? old.promise : Promise.resolve([`${selected}:${shell}`])
        },
      }
    }, () => "query failed")
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    setServer("new")
    await flush()
    expect(shells().items).toEqual(["new:auto"])
    old.reject(new Error("old server disconnected"))
    await flush()
    expect(shells().error).toBeUndefined()
    expect(shells().items).toEqual(["new:auto"])
    setConfigured("pwsh")
    await flush()
    expect(shells().items).toEqual(["new:pwsh"])
    expect(calls).toEqual(["old:/same:auto", "new:/same:auto", "new:/same:pwsh"])
  } finally {
    dispose()
  }
})
