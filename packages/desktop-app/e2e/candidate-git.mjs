import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { _electron } from "playwright-core"

// The launch binding contains only a loopback credential, never an upstream key.
const binding = JSON.parse(await readFile(process.argv[2], "utf8"))
const root = resolve(binding.output)
assert.equal(
  await stat(root).then(
    () => true,
    () => false,
  ),
  false,
  "fresh isolated profile required",
)
await mkdir(root, { recursive: true })
const env = Object.fromEntries(
  ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
)
for (const [key, leaf] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "config",
  LOCALAPPDATA: "cache",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  XDG_CACHE_HOME: "cache",
  TEMP: "temp",
  TMP: "temp",
  TMPDIR: "temp",
  ZAOVRA_TEST_MANAGED_CONFIG_DIR: "managed",
})) {
  env[key] = join(root, leaf)
  await mkdir(env[key], { recursive: true })
}
Object.assign(env, {
  ZAOVRA_TEST_ONBOARDING: "1",
  ZAOVRA_DISABLE_MODELS_FETCH: "true",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost,::1",
})
const profile = join(root, "temp", "profile")

const project = join(root, "git-project")
await mkdir(project)
const git = (...args) => execFileSync("git", ["-C", project, ...args], { env, encoding: "utf8", windowsHide: true })
git("init", "-b", "main")
await writeFile(join(project, "proof.txt"), "ORIGINAL_LINE\n")
git("add", "proof.txt")
git(
  "-c",
  "user.name=Local fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-m",
  "test: initial fixture",
)
await writeFile(join(project, "proof.txt"), "CHANGED_LINE\nSECOND_LINE\n")
await writeFile(join(project, "new-proof.txt"), "UNTRACKED_LINE\n")
const result = { sourceSHA: binding.sourceSHA, version: binding.version, phases: [], pass: false }
let sessionID
try {
  for (const phase of ["first", "restart"]) {
    const item = { phase, errors: [], closed: false, traffic: [] }
    result.phases.push(item)
    let desktop, page, child
    try {
      desktop = await _electron.launch({
        executablePath: binding.executable,
        args: ["--user-data-dir=" + profile, "--lang=zh-CN"],
        env,
        timeout: 90000,
      })
      child = desktop.process()
      item.pid = child.pid
      item.runtime = await desktop.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        version: app.getVersion(),
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        home: app.getPath("home"),
        documents: app.getPath("documents"),
      }))
      assert(item.runtime.packaged)
      assert.equal(item.runtime.version, binding.version)
      item.runtime.asarSHA256 = createHash("sha256")
        .update(await readFile(item.runtime.appPath))
        .digest("hex")
      assert.equal(item.runtime.asarSHA256, binding.asarSHA256)
      for (const dir of [item.runtime.userData, item.runtime.home, item.runtime.documents])
        assert(
          resolve(dir)
            .toLowerCase()
            .startsWith(root.toLowerCase() + "\\"),
        )
      page = await desktop.firstWindow({ timeout: 90000 })
      page.setDefaultTimeout(15000)
      page.on("pageerror", (error) => item.errors.push({ name: error.name, message: error.message.slice(0, 300) }))
      item.sessionReads = []
      page.on("response", async (response) => {
        if (!/\/api\/session\//.test(response.url())) return
        const entry = { url: response.url(), status: response.status() }
        item.sessionReads.push(entry)
        if (response.status() >= 400) entry.error = await response.text().catch(() => "unavailable")
      })
      await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      if (phase === "restart") {
        const connection = await page.evaluate(() => window.api.awaitInitialization())
        const response = await fetch(connection.url + "/api/session/" + sessionID, {
          headers: {
            Authorization:
              "Basic " +
              Buffer.from((connection.username ?? "") + ":" + (connection.password ?? "")).toString("base64"),
          },
          signal: AbortSignal.timeout(20000),
        })
        item.coldSessionRead = { status: response.status, body: await response.json() }
        await writeFile(join(root, "cold-session-read.json"), JSON.stringify(item.coldSessionRead, null, 2))
      }
      const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
      await input.waitFor({ state: "visible", timeout: 90000 })

      page.on("response", (response) => {
        if (/\/(?:api\/)?vcs\/(status|diff)(\?|$)/.test(response.url()))
          item.traffic.push({ url: response.url(), status: response.status() })
      })
      if (phase === "first") {
        const connection = await page.evaluate(() => window.api.awaitInitialization())
        const auth =
          "Basic " + Buffer.from((connection.username ?? "") + ":" + (connection.password ?? "")).toString("base64")
        const response = await fetch(connection.url + "/api/session", {
          method: "POST",
          headers: { Authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({ location: { directory: project } }),
          signal: AbortSignal.timeout(20000),
        })
        assert(response.ok)
        sessionID = (await response.json()).data.id
        const windowID = await page.evaluate(() => window.api.getWindowID())
        await page.evaluate(
          ({ windowID, sessionID }) =>
            localStorage.setItem(
              "zaovra.desktop.window." + windowID + ".last-active-url",
              "/server/c2lkZWNhcg/session/" + sessionID,
            ),
          { windowID, sessionID },
        )
        await page.reload()
      }
      // Desktop uses MemoryRouter; the renderer URL stays at index.html.
      await until(
        () =>
          page.evaluate(async (id) => {
            const windowID = await window.api.getWindowID()
            return localStorage
              .getItem("zaovra.desktop.window." + windowID + ".last-active-url")
              ?.endsWith("/session/" + id)
          }, sessionID),
        "restored target session",
      )
      item.sessionID = sessionID
      const toggle = page.getByRole("button", { name: "切换审查", exact: true })
      await toggle.waitFor({ state: "visible", timeout: 45000 })
      item.entryVisible = true
      item.statusBeforeOpen = item.traffic.filter((entry) => /\/status(\?|$)/.test(entry.url))
      item.diffBeforeOpen = item.traffic.filter((entry) => /\/diff(\?|$)/.test(entry.url))
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click()
      await page.getByText("proof.txt", { exact: true }).first().waitFor({ state: "visible" })
      await page.getByText("proof.txt", { exact: true }).first().click()
      await page.getByText("CHANGED_LINE", { exact: false }).first().waitFor({ state: "visible" })
      item.diffVisible = true
      const database = new DatabaseSync(join(profile, "desktop", "backend", "data", "zaovra", "zaovra.db"), {
        readOnly: true,
      })
      try {
        assert.equal(
          database.prepare("select count(*) as n from session_message").get().n,
          0,
          "Git entry is visible without sending any model prompt",
        )
        assert.equal(Object.values(database.prepare("pragma quick_check").get())[0], "ok")
      } finally {
        database.close()
      }
      await capture(desktop, phase + "-changes.png")
      item.gitStatus = git("status", "--porcelain")
      assert(item.gitStatus.includes(" M proof.txt") && item.gitStatus.includes("?? new-proof.txt"))
      if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click()
      item.pass = true
    } finally {
      if (page && !page.isClosed()) {
        await writeFile(
          join(root, phase + "-ui.txt"),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        )
        await capture(desktop, phase + "-final.png").catch(() => {})
      }
      if (desktop) {
        item.processes = await desktop
          .evaluate(({ app }) => app.getAppMetrics().map((entry) => ({ pid: entry.pid, type: entry.type })))
          .catch(() => [])
        await desktop.close()
        item.closed = child.exitCode === 0 && child.signalCode === null
        await until(
          () =>
            item.processes.every((entry) => {
              try {
                process.kill(entry.pid, 0)
                return false
              } catch {
                return true
              }
            }),
          "all test app processes closed",
          5000,
        )
      }
      await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
    }
    assert(item.pass && item.closed && item.errors.length === 0)
  }
  result.pass = true
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 1800) }
  process.exitCode = 1
} finally {
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, failure: result.failure }))
}

async function until(check, label, timeout = 30000) {
  const started = Date.now()
  while (!(await check())) {
    assert(Date.now() - started < timeout, label)
    await new Promise((done) => setTimeout(done, 100))
  }
}

async function capture(desktop, name) {
  const png = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (!window) throw new Error("Test window missing")
    return (await window.webContents.capturePage()).toPNG().toString("base64")
  })
  assert(png.length > 100, "nonempty native screenshot")
  await writeFile(join(root, name), Buffer.from(png, "base64"))
}
