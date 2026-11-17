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
// Memory is intentionally omitted: this tests the candidate's actual default.
const marker = "BETA_GATE_1724"
const prompts = [
  `这是隔离测试项目。请使用 write 工具创建 beta-proof.txt，内容严格为 ${marker}（不要换行）。只改这个文件，完成后简短回复“文件已写入”。`,
  `接着刚才的任务：请先用 read 读取 beta-proof.txt，确认原内容，再将内容改为 ${marker}_CONTINUED（不要换行）。只改这个文件，完成后简短回复“续接已完成”。`,
]
const result = {
  sourceSHA: binding.sourceSHA,
  version: binding.version,
  kind: binding.kind,
  model: binding.model,
  phases: [],
  pass: false,
}
let sessionID
let firstUsers
try {
  // Let the real first launch initialize its backend profile before adding a provider.
  // Pre-creating backend/config would correctly trigger the partial-upgrade guard.
  for (let phase = -1; phase < 2; phase++) {
    const item = { phase, prompt: prompts[phase], errors: [], approvals: [], closed: false }
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
      assert.equal(item.runtime.packaged, true)
      assert.equal(item.runtime.version, binding.version)
      item.runtime.asarSHA256 = createHash("sha256")
        .update(await readFile(item.runtime.appPath))
        .digest("hex")
      assert.equal(item.runtime.asarSHA256, binding.asarSHA256, "actual loaded archive matches frozen candidate")
      for (const dir of [item.runtime.userData, item.runtime.home, item.runtime.documents])
        assert(
          resolve(dir)
            .toLowerCase()
            .startsWith(root.toLowerCase() + "\\"),
          "isolated runtime paths",
        )
      page = await desktop.firstWindow({ timeout: 90000 })
      page.setDefaultTimeout(30000)
      page.on("pageerror", (error) => item.errors.push({ name: error.name, message: error.message.slice(0, 300) }))
      await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      if (phase === -1) {
        await page
          .locator('[data-component="prompt-input"][contenteditable="true"]')
          .waitFor({ state: "visible", timeout: 90000 })
        item.bootstrap = true
      }
      if (phase >= 0) {
        if (phase === 1) {
          const tab = page.locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]').filter({
            has: page.locator(`a[href*="${sessionID}"]`),
          })
          await tab.click()
          await page
            .locator('[data-slot="session-turn-assistant-content"]')
            .getByText("文件已写入", { exact: false })
            .first()
            .waitFor({ state: "visible" })
        }
        const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
        await input.waitFor({ state: "visible", timeout: 90000 })
        await page.waitForFunction(
          (model) =>
            [...document.querySelectorAll('[data-action="prompt-model"]')].some((node) =>
              node.textContent?.includes(model),
            ),
          binding.model,
          { timeout: 90000 },
        )
        await input.fill(prompts[phase])
        await input.press("Enter")
        const answer = page
          .locator('[data-slot="session-turn-assistant-content"]')
          .getByText(phase === 0 ? "文件已写入" : "续接已完成", { exact: false })
          .last()
        const database = new DatabaseSync(join(profile, "desktop", "backend", "data", "zaovra", "zaovra.db"), {
          readOnly: true,
        })
        const started = Date.now()
        try {
          while (true) {
            assert(Date.now() - started < 240000, "candidate turn did not settle within observation deadline")
            const rows = database
              .prepare("select id,type,data from session_message order by seq")
              .all()
              .map((row) => ({ ...row, data: JSON.parse(row.data) }))
            const user = rows.findLastIndex((row) => row.type === "user" && row.data.text === prompts[phase])
            const current = user < 0 ? [] : rows.slice(user + 1).filter((row) => row.type === "assistant")
            const failed = current.find((row) => row.data.finish === "interrupted" || row.data.finish === "error")
            if (failed) {
              item.terminalFailure = {
                id: failed.id,
                finish: failed.data.finish,
                termination: failed.data.termination,
                observedAfterMs: Date.now() - started,
              }
              throw new Error("candidate turn terminated: " + JSON.stringify(item.terminalFailure))
            }
            const dock = page.locator('[data-notification-target^="permission:"]')
            if (await dock.isVisible()) {
              const id = await dock.getAttribute("data-notification-target")
              if (!item.approvals.some((entry) => entry.id === id)) {
                const permission = await dock.locator('[data-slot="permission-details"] > code').textContent()
                const patterns = await dock.locator('[data-slot="permission-patterns"] code').allTextContents()
                const tool = current
                  .flatMap((row) => row.data.content)
                  .findLast((part) => part.type === "tool" && part.name === "bash" && part.state.status === "running")
                if (tool) {
                  const project = join(item.runtime.documents, "Zaovra 项目")
                  const command = tool.state.input.command
                  const workdir = resolve(project, tool.state.input.workdir ?? ".")
                  const approved =
                    permission === "bash" &&
                    patterns.length === 1 &&
                    patterns[0] === command &&
                    workdir.toLowerCase() === resolve(project).toLowerCase() &&
                    (binding.approvedCommands ?? []).includes(command)
                  item.approvals.push({ id, permission, patterns, command, workdir, approved })
                  await writeFile(join(root, `phase-${phase}-approvals.json`), JSON.stringify(item.approvals, null, 2))
                  assert(approved, "unreviewed permission request; do not grant blanket approval")
                  await dock.getByRole("button", { name: /^(允许一次|Allow once)$/, exact: true }).click()
                }
              }
            }
            // A visible answer must also have a durable successful terminal and an idle UI.
            if (
              current.at(-1)?.data.finish === "stop" &&
              (await answer.isVisible()) &&
              !(await page.locator('[data-action="prompt-stop"]').isVisible())
            )
              break
            await new Promise((done) => setTimeout(done, 250))
          }
        } finally {
          database.close()
        }
        const file = join(item.runtime.documents, "Zaovra 项目", "beta-proof.txt")
        const bytes = await readFile(file)
        assert.equal(bytes.toString(), marker + (phase === 1 ? "_CONTINUED" : ""))
        item.artifact = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
        await page.screenshot({ path: join(root, `phase-${phase}.png`) })
      }
    } finally {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(root, `phase-${phase}-final.png`) }).catch(() => {})
        await writeFile(
          join(root, `phase-${phase}-ui.txt`),
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
        item.exit = { code: child.exitCode, signal: child.signalCode }
        item.closed = child.exitCode === 0 && child.signalCode === null
        const remaining = () =>
          item.processes.filter((p) => {
            try {
              process.kill(p.pid, 0)
              return true
            } catch {
              return false
            }
          })
        const deadline = Date.now() + 5000
        while (remaining().length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
        item.remaining = remaining()
        assert.equal(item.remaining.length, 0, "fully close previous client/backend before relaunch")
      }
      await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
    }
    assert(item.closed)
    assert.equal(item.errors.length, 0)
    if (phase === -1) {
      const upgrade = JSON.parse(await readFile(join(profile, "desktop", "backend", "upgrade.json"), "utf8"))
      assert.deepEqual(upgrade, { version: 1, channel: "beta", action: "empty" })
      await mkdir(config, { recursive: true })
      await writeFile(join(config, "zaovra.json"), modelConfig, { flag: "wx" })
      continue
    }
    const database = join(profile, "desktop", "backend", "data", "zaovra", "zaovra.db")
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      const sessions = db.prepare("select id,directory,model from session where parent_id is null").all()
      assert.equal(sessions.length, 1, "one durable user session across restart")
      if (phase === 0) sessionID = sessions[0].id
      assert.equal(sessions[0].id, sessionID)
      const messages = db
        .prepare("select id,type,seq,data from session_message where session_id=? order by seq")
        .all(sessionID)
        .map((row) => ({ ...row, data: JSON.parse(row.data) }))
      const users = messages.filter((row) => row.type === "user")
      assert.equal(users.length, phase + 1)
      assert.deepEqual(
        users.map((row) => row.data.text),
        prompts.slice(0, phase + 1),
      )
      if (phase === 0) firstUsers = users
      if (phase === 1) assert.deepEqual(users.slice(0, 1), firstUsers, "original prompt preserved without duplication")
      const tools = messages.flatMap((row) =>
        row.type === "assistant" ? row.data.content.filter((part) => part.type === "tool") : [],
      )
      assert(
        tools.some(
          (tool) =>
            tool.state.status === "completed" &&
            (tool.name === "write" ||
              (tool.name === "bash" &&
                item.approvals.some((entry) => entry.approved && entry.command === tool.state.input.command))),
        ),
        "actual successful write tool or explicitly reviewed write command, with exact artifact bytes checked above",
      )
      if (phase === 1)
        assert(
          tools.some((tool) => tool.name === "read" && tool.state.status === "completed"),
          "actual read after restart",
        )
      const notes = db.prepare("select count(*) as count from memory_note").get().count
      const tidy = db.prepare("select count(*) as count from memory_automatic_run").get().count
      assert.equal(notes, 0, "default memory does not create notes")
      assert.equal(tidy, 0, "no automatic tidy")
      assert.equal(Object.values(db.prepare("pragma quick_check").get())[0], "ok")
      item.database = { file: database, sessionID, users: users.length, toolCount: tools.length, notes, tidy }
      await writeFile(join(root, `phase-${phase}-messages.json`), JSON.stringify(messages, null, 2))
    } finally {
      db.close()
    }
  }
  result.pass = true
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 1800) }
  process.exitCode = 1
} finally {
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, phases: result.phases.length, failure: result.failure }))
}
