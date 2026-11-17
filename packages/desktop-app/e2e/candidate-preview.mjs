import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { _electron } from "playwright-core"

const binding = JSON.parse(await readFile(process.argv[2], "utf8"))
const root = resolve(binding.output)
assert.equal(
  await stat(root).then(
    () => true,
    () => false,
  ),
  false,
  "fresh profile required",
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
const projects = { a: join(root, "project-a"), b: join(root, "project-b") }
for (const directory of Object.values(projects)) {
  await mkdir(directory)
  await writeFile(join(directory, "index.html"), html("initial"))
  await writeFile(join(directory, "other.html"), html("other"))
}
const result = { sourceSHA: binding.sourceSHA, version: binding.version, phases: [], observations: [], pass: false }
try {
  for (const phase of ["first", "restart"]) {
    const item = { phase, errors: [], closed: false }
    result.phases.push(item)
    let desktop, child, page
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
      for (const directory of [item.runtime.userData, item.runtime.home, item.runtime.documents])
        assert(
          resolve(directory)
            .toLowerCase()
            .startsWith(root.toLowerCase() + "\\"),
        )
      page = await desktop.firstWindow({ timeout: 90000 })
      page.setDefaultTimeout(20000)
      page.on("pageerror", (e) => item.errors.push({ name: e.name, message: e.message.slice(0, 300) }))
      await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      const a = await open("a", "index.html")
      const originalOrigin = a.origin
      if (phase === "first") {
        assert.equal(a.value, "EMPTY")
        await save("A_SAVED")
        await close()
        assert.equal((await open("a", "index.html")).value, "A_SAVED")
        for (let cycle = 0; cycle < (binding.cycles ?? 0); cycle++) {
          await save("A_SAVED")
          await close()
          assert.equal((await open("a", "index.html")).value, "A_SAVED")
        }
        await writeFile(join(projects.a, "index.html"), html("changed-on-disk"))
        await page.evaluate(() => window.api.artifactPreview.action({ id: "proof", action: "reload" }))
        await until(async () => {
          const state = await page.evaluate(() => window.api.artifactPreview.state("proof"))
          const content = await inspect()
          return state && !state.loading && content?.ready === "complete" && content.version === "changed-on-disk"
        }, "updated file loads")
        const changed = await inspect()
        assert.equal(changed.value, "A_SAVED")
        assert.equal(changed.origin, originalOrigin)
        result.observations.push({ phase, check: "file-change-reload", ...changed })
        const sibling = await open("a", "other.html")
        assert.equal(sibling.value, "A_SAVED")
        assert.equal(sibling.origin, originalOrigin)
        const b = await open("b", "index.html")
        assert.equal(b.value, "EMPTY")
        assert.notEqual(b.origin, originalOrigin)
        await save("B_SAVED")
        assert.equal((await open("a", "index.html")).value, "A_SAVED")
      } else {
        assert.equal(a.value, "A_SAVED")
        assert.equal(a.version, "changed-on-disk")
        const b = await open("b", "index.html")
        assert.equal(b.value, "B_SAVED")
        assert.notEqual(b.origin, originalOrigin)
        assert.equal((await open("a", "other.html")).value, "A_SAVED")
      }
      const png = await desktop.evaluate(async ({ webContents }) => {
        const view = webContents.getAllWebContents().find((w) => w.getURL().startsWith("oc://artifact-"))
        return (await view.capturePage()).toPNG().toString("base64")
      })
      await writeFile(join(root, phase + "-preview.png"), Buffer.from(png, "base64"))
      await close()
      item.previewPassed = true
      if (phase === "first") {
        item.terminalControls = await page.locator('[aria-controls="terminal-panel"]').count()
        await writeFile(
          join(root, "terminal-controls.json"),
          JSON.stringify(
            await page
              .locator("button")
              .evaluateAll((nodes) =>
                nodes.map((n) => ({
                  text: n.textContent,
                  label: n.getAttribute("aria-label"),
                  controls: n.getAttribute("aria-controls"),
                })),
              ),
            null,
            2,
          ),
        )
        if (binding.terminal) {
          const connection = await page.evaluate(() => window.api.awaitInitialization())
          const auth =
            "Basic " + Buffer.from((connection.username ?? "") + ":" + (connection.password ?? "")).toString("base64")
          const api = async (path, method = "GET", body) => {
            const response = await fetch(connection.url + path, {
              method,
              headers: { Authorization: auth, "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: AbortSignal.timeout(20000),
            })
            assert(response.ok, method + " " + path + " status " + response.status)
            return response.status === 204 ? undefined : response.json()
          }
          // Creating an empty Session makes the normal terminal controls available;
          // it admits no prompt and invokes no provider.
          const created = await api("/api/session", "POST", { location: { directory: projects.a } })
          item.sessionID = created.data.id
          await api("/api/session/" + item.sessionID, "PATCH", { title: "Narrow terminal validation" })
          // This isolated directory is not pinned in the project sidebar. Use the
          // desktop's persisted route to select the real empty Session on reload.
          const windowID = await page.evaluate(() => window.api.getWindowID())
          await page.evaluate(
            ({ windowID, sessionID }) =>
              localStorage.setItem(
                "zaovra.desktop.window." + windowID + ".last-active-url",
                "/server/c2lkZWNhcg/session/" + sessionID,
              ),
            { windowID, sessionID: item.sessionID },
          )
          await page.reload()
          await page.locator('[data-component="prompt-input"][contenteditable="true"]').waitFor({ state: "visible" })
          const win = await desktop.browserWindow(page)
          await win.evaluate((w) => w.setSize(900, 700))
          const traffic = []
          const sizes = []
          page.on("websocket", (socket) => {
            if (!new URL(socket.url()).pathname.includes("/api/pty/")) return
            socket.on("framereceived", (frame) =>
              traffic.push(Buffer.isBuffer(frame.payload) ? frame.payload.toString("utf8") : frame.payload),
            )
          })
          page.on("request", (request) => {
            if (request.method() === "PUT" && new URL(request.url()).pathname.startsWith("/api/pty/"))
              sizes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
          })
          await page.locator('[aria-controls="terminal-panel"]').click()
          const terminal = page.locator('[data-component="terminal"]:visible').first()
          await terminal.waitFor({ state: "visible" })
          const query = "?directory=" + encodeURIComponent(projects.a)
          await until(async () => (await api("/api/pty" + query)).data.length === 1, "one real PTY")
          item.pty = (await api("/api/pty" + query)).data[0]
          assert(/powershell|pwsh/i.test(item.pty.command), "PowerShell fixture command requires PowerShell")
          item.terminalSizes = []
          for (const width of [900, 1280, 900, 1280]) {
            const previousSizeCount = sizes.length
            await win.evaluate((w, width) => w.setSize(width, 700), width)
            await until(async () => {
              const measure = await terminal.evaluate((node) => {
                const canvas = node.querySelector("canvas")?.getBoundingClientRect()
                return { outer: node.getBoundingClientRect().width, canvas: canvas?.width ?? 0 }
              })
              return (
                measure.outer > 200 &&
                measure.canvas > 150 &&
                measure.canvas <= measure.outer &&
                sizes.at(-1)?.body?.size?.cols > 10 &&
                (item.terminalSizes.length === 0 || sizes.length > previousSizeCount)
              )
            }, "terminal has nonzero rendered width and backend columns")
            const measure = await terminal.evaluate((node) => ({
              outer: node.getBoundingClientRect().width,
              canvas: node.querySelector("canvas").getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
            }))
            const ptys = (await api("/api/pty" + query)).data
            assert.equal(ptys.length, 1)
            assert.equal(ptys[0].id, item.pty.id)
            item.terminalSizes.push({ windowWidth: width, ...measure, sentSize: sizes.at(-1) })
            await page.screenshot({ path: join(root, `terminal-${item.terminalSizes.length}-${width}.png`) })
          }
          const input = terminal.locator("textarea")
          await input.pressSequentially("[Console]::WriteLine('TERM_' + 'OUTPUT_01')", { delay: 15 })
          await input.press("Enter")
          await until(() => traffic.join("").includes("TERM_OUTPUT_01"), "real shell emits joined marker")
          await page.screenshot({ path: join(root, "terminal-output.png") })
          await page
            .getByRole("button", { name: /^(关闭终端|Close terminal)$/ })
            .first()
            .click()
          await until(async () => (await api("/api/pty" + query)).data.length === 0, "UI close removes real PTY")
          await writeFile(join(root, "terminal-traffic.json"), JSON.stringify({ sizes, frames: traffic }, null, 2))
          item.terminalPassed = true
        }
      }
      async function open(project, target) {
        await flushProbe()
        await page.evaluate((input) => window.api.artifactPreview.open(input), {
          id: "proof",
          target,
          directory: projects[project],
        })
        await page.evaluate(() =>
          window.api.artifactPreview.bounds({
            id: "proof",
            bounds: { x: 260, y: 90, width: 600, height: 430 },
            visible: true,
          }),
        )
        await until(async () => {
          const state = await page.evaluate(() => window.api.artifactPreview.state("proof"))
          const content = await inspect()
          return (
            state &&
            !state.loading &&
            !state.error &&
            state.url.endsWith("/" + target) &&
            content?.url.endsWith("/" + target) &&
            content.ready === "complete" &&
            content.version
          )
        }, "preview loads")
        const state = await inspect()
        result.observations.push({ phase, check: "open", project, target, ...state })
        return state
      }
      async function inspect() {
        return desktop.evaluate(async ({ webContents }) => {
          const view = webContents.getAllWebContents().find((w) => w.getURL().startsWith("oc://artifact-"))
          return view?.executeJavaScript(
            "({origin:location.origin,url:location.href,value:document.querySelector('#value')?.textContent,rawValue:localStorage.getItem('proof'),ready:document.readyState,version:document.querySelector('#version')?.textContent})",
          )
        })
      }
      async function save(value) {
        await desktop.evaluate(async ({ webContents }, value) => {
          const view = webContents.getAllWebContents().find((w) => w.getURL().startsWith("oc://artifact-"))
          await view.executeJavaScript(
            "document.querySelector('#entry').value=" +
              JSON.stringify(value) +
              ";document.querySelector('#save').click()",
          )
        }, value)
        assert.equal((await inspect()).value, value)
        result.observations.push({ phase, check: "save", ...(await inspect()) })
      }
      async function close() {
        await flushProbe()
        await page.evaluate(() => window.api.artifactPreview.action({ id: "proof", action: "close" }))
        assert.equal(
          await desktop.evaluate(
            ({ webContents }) =>
              webContents.getAllWebContents().filter((w) => w.getURL().startsWith("oc://artifact-")).length,
          ),
          0,
        )
      }
      async function flushProbe() {
        if (binding.delayProbe) await new Promise((done) => setTimeout(done, binding.delayProbe))
        if (!binding.flushProbe) return
        await desktop.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((w) => w.getURL().startsWith("oc://artifact-"))
            .forEach((w) => w.session.flushStorageData()),
        )
      }
    } catch (error) {
      item.failure = { name: error.name, message: String(error.message).slice(0, 1800) }
      if (desktop)
        item.previewAtFailure = await desktop
          .evaluate(async ({ webContents }) =>
            Promise.all(
              webContents
                .getAllWebContents()
                .filter((w) => w.getURL().startsWith("oc://artifact-"))
                .map(async (w) => ({
                  id: w.id,
                  pid: w.getOSProcessId(),
                  url: w.getURL(),
                  storagePath: w.session.storagePath,
                  snapshot: await w.executeJavaScript(
                    "({value:document.querySelector('#value')?.textContent,raw:localStorage.getItem('proof'),ready:document.readyState})",
                  ),
                })),
            ),
          )
          .catch((error) => ({ error: String(error.message) }))
      await writeFile(join(root, "failure-before-cleanup.json"), JSON.stringify(result, null, 2))
      if (binding.diagnose && desktop) {
        item.delayedStorage = await desktop
          .evaluate(async ({ webContents }) => {
            const view = webContents.getAllWebContents().find((w) => w.getURL().startsWith("oc://artifact-"))
            if (!view) return []
            const samples = []
            for (const delay of [500, 2000]) {
              await new Promise((done) => setTimeout(done, delay))
              samples.push({
                delay,
                state: await view.executeJavaScript(
                  "({raw:localStorage.getItem('proof'),value:document.querySelector('#value')?.textContent})",
                ),
              })
            }
            await new Promise((done) => {
              view.once("did-finish-load", done)
              view.reload()
            })
            samples.push({
              reload: true,
              state: await view.executeJavaScript(
                "({raw:localStorage.getItem('proof'),value:document.querySelector('#value')?.textContent})",
              ),
            })
            return samples
          })
          .catch((error) => ({ error: String(error.message) }))
        await writeFile(join(root, "failure-diagnostics.json"), JSON.stringify(result, null, 2))
      }
      throw error
    } finally {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(root, phase + "-window.png") }).catch(() => {})
        await writeFile(
          join(root, phase + "-ui.txt"),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        )
      }
      if (desktop) {
        if (page && !page.isClosed())
          await page.evaluate(() => window.api.artifactPreview.action({ id: "proof", action: "close" })).catch(() => {})
        item.processes = await desktop
          .evaluate(({ app }) => app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type })))
          .catch(() => [])
        const closing = desktop.close()
        let timer
        try {
          await Promise.race([
            closing,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("application close exceeded 15 seconds")), 15000)
            }),
          ])
        } catch (error) {
          item.closeFailure = String(error.message)
          const browser = item.processes.find((p) => p.type === "Browser")
          if (browser) process.kill(browser.pid)
          await closing.catch(() => {})
          throw error
        } finally {
          clearTimeout(timer)
        }
        item.closed = child.exitCode === 0 && child.signalCode === null
        await until(
          () =>
            item.processes.every((p) => {
              try {
                process.kill(p.pid, 0)
                return false
              } catch {
                return true
              }
            }),
          "app tree closes",
          5000,
        )
      }
      await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
    }
    assert(item.closed && item.previewPassed && item.errors.length === 0)
  }
  result.pass = true
} catch (e) {
  result.failure = { name: e.name, message: String(e.message).slice(0, 1800) }
  process.exitCode = 1
} finally {
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, failure: result.failure }))
}
function html(version) {
  return `<!doctype html><meta charset="utf-8"><title>Isolated preview persistence</title><style>body{font:20px system-ui;background:#eef4ff;padding:36px;color:#13213b}button,input{font:inherit;padding:8px}output{display:block;margin:24px 0}</style><h1>Preview persistence</h1><p id="version">${version}</p><input id="entry"><button id="save">Save local value</button><output id="value"></output><script>const value=document.querySelector('#value');const read=()=>value.textContent=localStorage.getItem('proof')??'EMPTY';read();document.querySelector('#save').onclick=()=>{localStorage.setItem('proof',document.querySelector('#entry').value);read()}</script>`
}
async function until(check, label, timeout = 20000) {
  const start = Date.now()
  while (!(await check())) {
    assert(Date.now() - start < timeout, label)
    await new Promise((done) => setTimeout(done, 100))
  }
}
