import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { previewURL, serveArtifact } from "./artifact-server"
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
test("serves an HTML artifact and its relative assets, without exposing dotfiles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-artifact-test-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "成果"))
  await writeFile(path.join(dir, "成果", "demo.html"), '<link rel="stylesheet" href="style.css"><button>Works</button>')
  await writeFile(path.join(dir, "成果", "style.css"), "button{color:red}")
  await writeFile(path.join(dir, ".secret.json"), "secret")
  const server = await serveArtifact("成果/demo.html", dir)
  cleanup.push(server.close)
  expect(await (await fetch(server.url)).text()).toContain("Works")
  expect(await (await fetch(new URL("style.css", server.url))).text()).toContain("color:red")
  expect((await fetch(new URL("/.secret.json", server.url))).status).toBe(403)
  expect((await fetch(server.url, { method: "POST" })).status).toBe(405)
})
test("rejects files outside the project root", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-artifact-test-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "project"))
  await writeFile(path.join(dir, "outside.html"), "private")
  await expect(serveArtifact("../outside.html", path.join(dir, "project"))).rejects.toThrow("当前项目")
})
test("allows local development and HTTPS, rejects privileged schemes and credential URLs", () => {
  expect(previewURL("http://localhost:3000")).toBe("http://localhost:3000/")
  expect(previewURL("https://example.com/demo")).toBe("https://example.com/demo")
  for (const target of [
    "javascript:alert(1)",
    "file:///C:/Windows/win.ini",
    "http://example.com",
    "https://user:pass@example.com",
  ])
    expect(() => previewURL(target)).toThrow()
})

test("isolates projects, serves edited contents without caching, and closes one preview independently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-preview-isolation-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const first = path.join(dir, "first")
  const second = path.join(dir, "second")
  await mkdir(first)
  await mkdir(second)
  await writeFile(path.join(first, "index.html"), "first version")
  await writeFile(path.join(second, "index.html"), "other project")
  const a = await serveArtifact("index.html", first)
  const b = await serveArtifact("index.html", second)
  cleanup.push(a.close, b.close)
  expect(a.url).not.toBe(b.url)
  expect(await (await fetch(a.url)).text()).toBe("first version")
  expect(await (await fetch(b.url)).text()).toBe("other project")
  await writeFile(path.join(first, "index.html"), "changed version")
  const changed = await fetch(a.url)
  expect(changed.headers.get("cache-control")).toBe("no-store")
  expect(await changed.text()).toBe("changed version")
  a.close()
  expect(await (await fetch(b.url)).text()).toBe("other project")
})
