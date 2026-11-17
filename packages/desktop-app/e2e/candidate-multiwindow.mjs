import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { join, resolve } from "node:path"
import { _electron } from "playwright-core"

// The launch binding contains only a loopback credential, never an upstream key.
const binding = JSON.parse(await readFile(process.argv[2], "utf8"))
const root = resolve(binding.output)
const endpoint = new URL(binding.baseURL)
assert(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && endpoint.pathname === "/v1")
assert(binding.sourceSHA.match(/^[a-f0-9]{40}$/) && binding.key && binding.model)
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
const config = join(profile, "desktop", "backend", "config", "zaovra")
const modelConfig = JSON.stringify(
  {
    model: `candidate/${binding.model}`,
    enabled_providers: ["candidate"],
    snapshot: false,
    shell: "powershell",
    permission: {
      "*": "allow",
      bash: "ask",
      external_directory: binding.denyExternal ? "deny" : "ask",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
    },
    provider: {
      candidate: {
        name: "Isolated candidate validation",
        env: [],
        npm: binding.protocol === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        options: { baseURL: binding.baseURL, apiKey: binding.key, timeout: 120000 },
        models: {
          [binding.model]: {
            name: binding.model,
            tool_call: true,
            reasoning: true,
            modalities: { input: ["text"], output: ["text"] },
            options: { maxTokens: 4096 },
            limit: { context: 131072, output: 4096 },
          },
        },
      },
    },
  },
  null,
  2,
)

// Both windows, admission, retry cancellation and file tools use the packaged app.
const result = { sourceSHA: binding.sourceSHA, version: binding.version, phases: [], cycles: [], pass: false }
let sessionID
try {
  for (const phase of ["bootstrap", "shared"]) {
    const item = { phase, errors: [], closed: false }
    result.phases.push(item)
    let desktop, child, db
    const pages = []
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
      const first = await desktop.firstWindow({ timeout: 90000 })
      observe(first)
      await first.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      await composer(first).waitFor({ state: "visible", timeout: 90000 })
      if (phase === "bootstrap") continue
      await first.waitForFunction(
        (model) =>
          [...document.querySelectorAll('[data-action="prompt-model"]')].some((node) =>
            node.textContent?.includes(model),
          ),
        binding.model,
        { timeout: 90000 },
      )
      db = new DatabaseSync(join(profile, "desktop", "backend", "data", "zaovra", "zaovra.db"), { readOnly: true })
      await submit(first, "SHARED_SEED: 请创建 shared-proof.txt。")
      await first.getByText("SHARED_READY", { exact: false }).last().waitFor({ state: "visible" })
      await until(() => rows(db).findLast((row) => row.type === "assistant")?.data.finish === "stop", "seed finishes")
      const sessions = db.prepare("select id,parent_id from session").all()
      assert.equal(sessions.length, 1)
      sessionID = sessions[0].id
      item.sessionID = sessionID
      await first.getByRole("button", { name: "Zaovra menu", exact: true }).click()
      await first.getByRole("menuitem", { name: /^(文件|File)$/ }).hover()
      const [second] = await Promise.all([
        desktop.waitForEvent("window"),
        first.getByRole("menuitem", { name: /^(新建窗口|New Window)/ }).click(),
      ])
      observe(second)
      await second.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      await second.locator(`[data-component="desktop-sidebar-v2"] a[href*="/session/${sessionID}"]`).first().click()
      await second.getByText("SHARED_READY", { exact: false }).last().waitFor({ state: "visible" })
      assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2)

      for (const cycle of [1, 2, 3]) {
        const sender = cycle % 2 ? first : second
        const viewer = cycle % 2 ? second : first
        const before = rows(db).filter((row) => row.type === "user")
        const handles = await Promise.all(pages.map((page) => composer(page).elementHandle()))
        const rate = `SHARED_RATE_${cycle}: 测试限流，等待我停止。`
        const resume = `SHARED_RESUME_${cycle}: 停止后继续，请读取并更新 shared-proof.txt。`
        await foreground(desktop, sender)
        await submit(sender, rate)
        await until(
          async () => (await readFile(join(root, `rate-${cycle}.json`), "utf8").catch(() => "")) === "http-429",
          "upstream returns 429",
        )
        for (const page of pages) {
          await page.getByText(rate, { exact: true }).waitFor({ state: "visible" })
          await stopButton(page).waitFor({ state: "visible" })
        }
        const rateUser = rows(db).findLast((row) => row.type === "user")
        await stopButton(sender).click()
        await until(
          () =>
            rows(db).some(
              (row) =>
                row.type === "assistant" &&
                row.data.turn === rateUser.id &&
                row.data.finish === "interrupted" &&
                row.data.termination?.source === "user",
            ),
          "429 retry stops durably",
        )
        for (const page of pages) {
          await stopButton(page).waitFor({ state: "hidden" })
          await composer(page).waitFor({ state: "visible" })
        }
        for (const handle of handles)
          assert(await handle.evaluate((node) => node.isConnected), "429 Stop preserves mounted composer")
        await foreground(desktop, viewer)
        await submit(viewer, resume)
        await until(
          async () => (await readFile(join(root, `live-${cycle}.json`), "utf8").catch(() => "")) === "stream-open",
          "recovery opens live stream",
        )
        for (const page of pages)
          await page
            .locator('[data-streaming="true"]')
            .filter({ hasText: `SHARED_LIVE_${cycle}` })
            .last()
            .waitFor({ state: "visible" })
        await writeFile(join(root, `release-${cycle}.json`), "finish", { flag: "wx" })
        await until(
          () => rows(db).findLast((row) => row.type === "assistant")?.data.finish === "stop",
          "recovery finishes",
        )
        for (const page of pages) {
          await page.getByText(`SHARED_LIVE_${cycle}`, { exact: false }).last().waitFor({ state: "visible" })
          await stopButton(page).waitFor({ state: "hidden" })
        }
        const users = rows(db).filter((row) => row.type === "user")
        assert.equal(users.length, 1 + cycle * 2)
        assert.deepEqual(users.slice(0, before.length), before, "existing user messages remain unchanged")
        const tools = rows(db)
          .filter((row) => row.type === "assistant" && row.data.turn === users.at(-1).id)
          .flatMap((row) => row.data.content)
          .filter((part) => part.type === "tool")
        assert.deepEqual(
          tools.map((part) => [part.name, part.state.status]),
          [
            ["read", "completed"],
            ["write", "completed"],
          ],
        )
        assert.equal(
          await readFile(join(item.runtime.documents, "Zaovra 项目", "shared-proof.txt"), "utf8"),
          `SHARED_${cycle}`,
        )
        result.cycles.push({
          cycle,
          rateUserID: rateUser.id,
          resumeUserID: users.at(-1).id,
          sharedLiveObserved: true,
          composerPreserved: true,
          pass: true,
        })
        await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
      }
      for (const [index, page] of pages.entries()) {
        await foreground(desktop, page)
        await page.screenshot({ path: join(root, `shared-window-${index + 1}.png`) })
      }
      await first.close()
      await foreground(desktop, second)
      await submit(second, "SHARED_AFTER_CLOSE: 关闭另一窗口后继续，只回复 SHARED_SURVIVED。")
      await until(() => {
        const history = rows(db)
        const users = history.filter((row) => row.type === "user")
        const assistant = history.findLast((row) => row.type === "assistant")
        return (
          users.length === 8 &&
          assistant?.data.turn === users.at(-1).id &&
          assistant.data.finish === "stop" &&
          assistant.data.content.some((part) => part.type === "text" && part.text === "SHARED_SURVIVED")
        )
      }, "remaining window completes its new input")
      await second.getByText("SHARED_SURVIVED", { exact: true }).last().waitFor({ state: "visible" })
      assert.equal(db.prepare("select count(*) as n from session").get().n, 1)
      assert.equal(rows(db).filter((row) => row.type === "user").length, 8)
      assert.equal(db.prepare("select count(*) as n from memory_note").get().n, 0)
      assert.equal(Object.values(db.prepare("pragma quick_check").get())[0], "ok")
      await writeFile(join(root, "messages.json"), JSON.stringify(rows(db), null, 2))
      item.remainingWindowContinued = true
      item.pass = true
    } finally {
      if (db) db.close()
      for (const [index, page] of pages.entries())
        if (!page.isClosed()) {
          await page.screenshot({ path: join(root, `${phase}-${index}-final.png`) }).catch(() => {})
          await writeFile(
            join(root, `${phase}-${index}-ui.txt`),
            await page
              .locator("body")
              .innerText()
              .catch(() => ""),
          )
        }
      if (desktop) {
        item.processes = await desktop
          .evaluate(({ app }) => app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type })))
          .catch(() => [])
        await desktop.close()
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
          "all launched app processes close",
          5000,
        )
      }
      await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
      if (phase === "bootstrap" && item.closed) {
        assert.deepEqual(JSON.parse(await readFile(join(profile, "desktop", "backend", "upgrade.json"), "utf8")), {
          version: 1,
          channel: "beta",
          action: "empty",
        })
        await mkdir(config, { recursive: true })
        await writeFile(join(config, "zaovra.json"), modelConfig, { flag: "wx" })
      }
    }
    assert(item.closed)
    assert.equal(item.errors.length, 0)

    function observe(page) {
      pages.push(page)
      page.setDefaultTimeout(20000)
      page.on("pageerror", (error) => item.errors.push({ name: error.name, message: error.message.slice(0, 300) }))
    }
  }
  assert(result.phases.every((phase) => phase.closed && phase.errors.length === 0))
  assert(result.phases[1].pass && result.cycles.length === 3)
  result.pass = true
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 1800) }
  process.exitCode = 1
} finally {
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, failure: result.failure }))
}

function rows(db) {
  const entries = sessionID
    ? db.prepare("select id,session_id,type,data from session_message where session_id=? order by seq").all(sessionID)
    : db.prepare("select id,session_id,type,data from session_message order by session_id,seq").all()
  return entries.map((row) => ({ ...row, data: JSON.parse(row.data) }))
}
function composer(page) {
  return page.locator('[data-component="prompt-input"][contenteditable="true"]')
}
function stopButton(page) {
  return page.locator('[data-action="prompt-stop"], [data-action="prompt-submit"][aria-label="Stop"]')
}
async function until(condition, label, timeout = 60000) {
  const started = Date.now()
  while (!(await condition())) {
    assert(Date.now() - started < timeout, label)
    await new Promise((done) => setTimeout(done, 100))
  }
}
async function foreground(desktop, page) {
  const window = await desktop.browserWindow(page)
  await window.evaluate((win) => {
    win.show()
    win.focus()
  })
  await page.bringToFront()
}
async function submit(page, text) {
  await composer(page).waitFor({ state: "visible" })
  await composer(page).fill(text)
  await page.locator('[data-action="prompt-submit"]').click()
}
