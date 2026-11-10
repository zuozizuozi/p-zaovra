import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { previewURL, serveArtifact, artifactSource, artifactFileAction } from "./artifact-server"
const cleanup: (() => Promise<unknown> | void)[] = []
test("549 unsupported native file actions use only fresh canonical files in the project, with no browser download", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-native-result-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const project = path.join(dir, "project")
  const outside = path.join(dir, "outside")
  await mkdir(project)
  await mkdir(outside)
  await writeFile(path.join(project, "report.docx"), "synthetic document")
  await writeFile(path.join(outside, "private.docx"), "synthetic outside fixture")
  await symlink(outside, path.join(project, "linked"), process.platform === "win32" ? "junction" : "dir")
  const calls: { file: string; action: string }[] = []
  const run = async (file: string, action: string) => {
    calls.push({ file, action })
  }
  for (const action of ["open", "reveal"] as const)
    await artifactFileAction({ target: "report.docx", directory: project, action }, run)
  expect(calls.map((item) => item.action)).toEqual(["open", "reveal"])
  expect(calls.every((item) => item.file === path.join(project, "report.docx"))).toBe(true)
  for (const target of [
    "../outside/private.docx",
    "linked/private.docx",
    "https://example.com/report.docx",
    "file:///secret",
    "missing.docx",
    ".",
  ]) {
    await expect(artifactFileAction({ target, directory: project, action: "open" }, run)).rejects.toThrow()
  }
  expect(calls).toHaveLength(2)
  await writeFile(path.join(project, "launch.exe"), "synthetic, never execute")
  await expect(artifactFileAction({ target: "launch.exe", directory: project, action: "open" }, run)).rejects.toThrow(
    "不在预览中执行",
  )
  expect(calls).toHaveLength(2)
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

test("817 project origin and persistent storage identity survive fresh sources, target changes and canonical aliases", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-stable-origin-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "project"))
  await writeFile(path.join(dir, "project", "index.html"), "first version")
  await writeFile(path.join(dir, "project", "other.html"), "second target")
  await symlink(path.join(dir, "project"), path.join(dir, "alias"), process.platform === "win32" ? "junction" : "dir")
  const first = await artifactSource("index.html", path.join(dir, "project"))
  await writeFile(path.join(dir, "project", "index.html"), "updated version")
  const reopened = await artifactSource("index.html", path.join(dir, "alias"))
  const other = await artifactSource("other.html", path.join(dir, "project"))
  expect(reopened.url).toBe(first.url)
  expect(reopened.partition).toBe(first.partition)
  expect(first.partition.startsWith("persist:artifact-")).toBe(true)
  expect(new URL(other.url).host).toBe(new URL(first.url).host)
  expect(other.partition).toBe(first.partition)
  const response = await reopened.respond(new Request(reopened.url))
  expect(await response.text()).toBe("updated version")
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("817 protocol responses isolate projects and reject foreign initiators, hidden files and escaping links", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zaovra-origin-boundary-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, "first"))
  await mkdir(path.join(dir, "second"))
  await writeFile(path.join(dir, "first", "index.html"), "first project")
  await writeFile(path.join(dir, "first", ".hidden.json"), "hidden")
  await writeFile(path.join(dir, "second", "index.html"), "second project")
  await symlink(
    path.join(dir, "second"),
    path.join(dir, "first", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  )
  const first = await artifactSource("index.html", path.join(dir, "first"))
  const second = await artifactSource("index.html", path.join(dir, "second"))
  expect(first.partition).not.toBe(second.partition)
  expect(new URL(first.url).host).not.toBe(new URL(second.url).host)
  expect((await first.respond(new Request(second.url))).status).toBe(403)
  expect((await first.respond({ url: first.url, method: "GET", initiatorOrigin: "https://example.com" })).status).toBe(
    403,
  )
  expect(
    (await first.respond({ url: first.url, method: "GET", initiatorOrigin: `oc://${new URL(second.url).host}` }))
      .status,
  ).toBe(403)
  expect((await first.respond(new Request(new URL("/.hidden.json", first.url)))).status).toBe(403)
  expect((await first.respond(new Request(new URL("/linked/index.html", first.url)))).status).toBe(403)
  expect((await first.respond(new Request(first.url, { method: "POST" }))).status).toBe(405)
  expect(await (await first.respond(new Request(first.url, { method: "HEAD" }))).text()).toBe("")
  expect(await (await second.respond(new Request(second.url))).text()).toBe("second project")
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
