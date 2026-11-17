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
      task: "allow",
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

// Only the provider is scripted. Task admission, tools, Session ownership and UI use the packaged application.
const result = { sourceSHA: binding.sourceSHA, version: binding.version, phases: [], pass: false }
const complete = "PARENT_COMPLETE: 请委托 general 子任务写入并读取 child-proof.txt，再报告结果。"
const stopPrompt = "PARENT_STOP: 继续同一子任务，写入 child-stop.txt 后持续解释；稍后我会停止。"
const followup = "PARENT_AFTER: 停止后继续，只回复 PARENT_CONTINUED，不调用工具。"
try {
  for (const phase of ["bootstrap", "subtask"]) {
    const item = { phase, errors: [], closed: false }
    result.phases.push(item)
    let desktop, page, child, db
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
      await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
      await input.waitFor({ state: "visible", timeout: 90000 })
      if (phase === "bootstrap") continue
      await page.waitForFunction(
        (model) =>
          [...document.querySelectorAll('[data-action="prompt-model"]')].some((node) =>
            node.textContent?.includes(model),
          ),
        binding.model,
        { timeout: 90000 },
      )
      db = new DatabaseSync(join(profile, "desktop", "backend", "data", "zaovra", "zaovra.db"), { readOnly: true })
      await submit(page, complete)
      await until(
        () =>
          rows(db).some(
            (row) =>
              row.type === "assistant" &&
              row.data.finish === "stop" &&
              row.data.content.some((part) => part.type === "text" && part.text.includes("PARENT_DONE")),
          ),
        "parent completes real task",
      )
      const sessions = db.prepare("select id,parent_id from session").all()
      assert.equal(sessions.length, 2, "one real parent and one real child")
      const parent = sessions.find((session) => session.parent_id === null)
      const subtask = sessions.find((session) => session.parent_id === parent.id)
      assert(subtask)
      item.parentID = parent.id
      item.childID = subtask.id
      const parentTools = rows(db, parent.id)
        .flatMap((row) => (row.type === "assistant" ? row.data.content : []))
        .filter((part) => part.type === "tool")
      assert.equal(parentTools.length, 1)
      assert.equal(parentTools[0].name, "task")
      assert.equal(parentTools[0].state.status, "completed")
      assert.equal(parentTools[0].state.structured.task_id, subtask.id)
      const childTools = rows(db, subtask.id)
        .flatMap((row) => (row.type === "assistant" ? row.data.content : []))
        .filter((part) => part.type === "tool")
      assert.deepEqual(
        childTools.map((part) => [part.name, part.state.status]),
        [
          ["write", "completed"],
          ["read", "completed"],
        ],
      )
      assert.equal(
        await readFile(join(item.runtime.documents, "Zaovra 项目", "child-proof.txt"), "utf8"),
        "CHILD_VERIFIED",
      )
      await page.getByText("PARENT_DONE", { exact: false }).last().waitFor({ state: "visible" })
      const parentURL = await activeRoute(page)
      await openChild(page, subtask.id)
      await page.getByText("CHILD_DONE", { exact: false }).last().waitFor({ state: "visible" })
      await until(async () => (await activeRoute(page)).includes(subtask.id), "actual desktop child route")
      await page.screenshot({ path: join(root, "child-completed.png") })
      item.completedNavigation = { parentURL, childURL: await activeRoute(page) }
      await returnParent(page, parent.id)
      await page.getByText("PARENT_DONE", { exact: false }).last().waitFor({ state: "visible" })
      await submit(page, stopPrompt)
      await until(() => {
        const history = rows(db, subtask.id)
        const users = history.filter((row) => row.type === "user")
        const assistant = history.findLast((row) => row.type === "assistant")
        // The streaming text part can already exist while its bytes remain ephemeral.
        return users.length === 2 && assistant?.data.turn === users[1].id && !assistant.data.finish
      }, "reused child starts streaming")
      await until(
        async () => (await readFile(join(root, "streaming.json"), "utf8").catch(() => "")) === "child-streaming",
        "provider has opened the child's live stream",
      )
      const stop = page.locator('[data-action="prompt-stop"], [data-action="prompt-submit"][aria-label="Stop"]')
      await stop.waitFor({ state: "visible" })
      await stop.click()
      await until(
        () =>
          rows(db, parent.id).at(-1)?.data.finish === "interrupted" &&
          rows(db, subtask.id).at(-1)?.data.finish === "interrupted",
        "parent Stop interrupts the owned child",
      )
      await stop.waitFor({ state: "hidden" })
      assert.equal(db.prepare("select count(*) as n from session").get().n, 2, "task_id reuses the existing child")
      assert.equal(
        await readFile(join(item.runtime.documents, "Zaovra 项目", "child-stop.txt"), "utf8"),
        "STOP_BEFORE_STREAM",
      )
      for (const id of [parent.id, subtask.id]) {
        const pending = rows(db, id)
          .flatMap((row) => (row.type === "assistant" ? row.data.content : []))
          .filter((part) => part.type === "tool" && ["queued", "pending", "running"].includes(part.state.status))
        assert.equal(pending.length, 0, "no tool remains running after Stop")
      }
      item.parentStop = rows(db, parent.id).at(-1).data.termination
      item.childStop = rows(db, subtask.id).at(-1).data.termination
      assert.equal(item.parentStop.source, "user")
      await openChild(page, subtask.id)
      await page.getByText("CHILD_STOP", { exact: false }).last().waitFor({ state: "visible" })
      await until(async () => (await activeRoute(page)).includes(subtask.id), "actual stopped child route")
      await page.screenshot({ path: join(root, "child-stopped.png") })
      await returnParent(page, parent.id)
      await submit(page, followup)
      await until(
        () =>
          rows(db, parent.id).at(-1)?.data.finish === "stop" &&
          rows(db, parent.id)
            .at(-1)
            .data.content.some((part) => part.type === "text" && part.text.includes("PARENT_CONTINUED")),
        "new parent input works after child cancellation",
      )
      await page.getByText("PARENT_CONTINUED", { exact: false }).last().waitFor({ state: "visible" })
      assert.deepEqual(
        rows(db, parent.id)
          .filter((row) => row.type === "user")
          .map((row) => row.data.text),
        [complete, stopPrompt, followup],
      )
      assert.deepEqual(
        rows(db, subtask.id)
          .filter((row) => row.type === "user")
          .map((row) => row.data.text),
        ["CHILD_COMPLETE", "CHILD_STOP"],
      )
      const childUsers = new Set(
        rows(db, subtask.id)
          .filter((row) => row.type === "user")
          .map((row) => row.id),
      )
      assert(
        rows(db, subtask.id)
          .filter((row) => row.type === "assistant")
          .every((row) => childUsers.has(row.data.turn)),
      )
      assert.equal(db.prepare("select count(*) as n from memory_note").get().n, 0)
      assert.equal(Object.values(db.prepare("pragma quick_check").get())[0], "ok")
      await writeFile(join(root, "messages.json"), JSON.stringify(rows(db), null, 2))
      await page.screenshot({ path: join(root, "parent-continued.png") })
      item.pass = true
    } finally {
      if (db) db.close()
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(root, `${phase}-final.png`) }).catch(() => {})
        await writeFile(
          join(root, `${phase}-ui.txt`),
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
  }
  assert(result.phases.every((phase) => phase.closed && phase.errors.length === 0))
  assert(result.phases[1].pass)
  result.pass = true
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 1800) }
  process.exitCode = 1
} finally {
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, failure: result.failure }))
}

function rows(db, sessionID) {
  const entries = sessionID
    ? db.prepare("select id,session_id,type,data from session_message where session_id=? order by seq").all(sessionID)
    : db.prepare("select id,session_id,type,data from session_message order by session_id,seq").all()
  return entries.map((row) => ({ ...row, data: JSON.parse(row.data) }))
}

async function until(condition, label, timeout = 60000) {
  const started = Date.now()
  while (!(await condition())) {
    assert(Date.now() - started < timeout, label)
    await new Promise((done) => setTimeout(done, 100))
  }
}

async function submit(page, text) {
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.waitFor({ state: "visible" })
  await input.fill(text)
  await page.locator('[data-action="prompt-submit"]').click()
}

async function openChild(page, id) {
  const link = page.locator(`a[href*="/session/${id}"]`).last()
  if (!(await link.isVisible())) {
    const disclosures = page.locator('[data-component="turn-process-summary"] button')
    for (const button of await disclosures.all()) {
      if (await button.isVisible()) await button.click()
      if (await link.isVisible()) break
    }
  }
  await link.waitFor({ state: "visible" })
  await link.click()
}

async function returnParent(page, id) {
  const tab = page.locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]').filter({
    has: page.locator(`a[href*="/session/${id}"]`),
  })
  await tab.click()
  await until(async () => (await activeRoute(page)).endsWith(`/session/${id}`), "actual parent route")
}

async function activeRoute(page) {
  // Packaged Electron uses DesktopMemoryRouter; the document URL never changes with a Session.
  return page.evaluate(
    () =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith("zaovra.desktop.window.") && key.endsWith(".last-active-url"))
        .map((key) => localStorage.getItem(key))
        .find((value) => value?.startsWith("/server/")) ?? "",
  )
}
