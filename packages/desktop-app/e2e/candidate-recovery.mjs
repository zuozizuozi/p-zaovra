import assert from "node:assert/strict"
import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises"
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

// Memory is omitted to exercise the real default. The same durable Session spans every cycle.
const plans = [{ mode: "write", value: "RECOVERY_0", segment: 0, read: false }]
for (let cycle = 1; cycle <= 3; cycle++) {
  const segment = cycle - 1
  const before = cycle === 1 ? "RECOVERY_0" : `RECOVERY_${cycle - 1}B`
  plans.push(
    { mode: "stop", value: before, segment, cycle },
    { mode: "write", value: `RECOVERY_${cycle}A`, segment, cycle, read: true },
    { mode: "error", value: `RECOVERY_${cycle}A`, segment, cycle },
    { mode: "write", value: `RECOVERY_${cycle}B`, segment, cycle, read: true },
    { mode: "read", value: `RECOVERY_${cycle}B`, segment, cycle },
  )
}
plans.push({ mode: "read", value: "RECOVERY_3B", segment: 3 })
const steps = plans.map((plan, index) => {
  const tag = `[RECOVERY case=${index} mode=${plan.mode}]`
  const answer = `验收完成${index}`
  const command = `Write-Error 'BETA_EXPECTED_ERROR_${plan.cycle}'; exit 7`
  const prompt =
    plan.mode === "stop"
      ? `${tag} 请详细解释文本文件与字节编码，至少写八千字。不要调用工具，不要修改任何文件。`
      : plan.mode === "error"
        ? `${tag} 这是隔离项目的故障恢复测试。只用 bash 执行一次这个确定会失败且不修改文件的 PowerShell 命令：${command}。不要重试或修复，不要修改文件。确认退出码7后回复“${answer}”。`
        : plan.mode === "read"
          ? `${tag} 请用 read 读取 beta-proof.txt，确认单行内容是 ${plan.value}。不要修改任何文件。回复“${answer}”，附上读到的内容。`
          : `${tag} ${plan.read ? "接续前面的会话，请先用 read 读取 beta-proof.txt，再" : "请"}用 write 将 beta-proof.txt 写成单行 ${plan.value}，允许一个末尾换行。只修改这个文件。完成后回复“${answer}”。`
  return { ...plan, index, prompt, answer, command }
})
const result = {
  sourceSHA: binding.sourceSHA,
  version: binding.version,
  model: binding.model,
  kind: binding.kind,
  launches: [],
  turns: [],
  pass: false,
}
let sessionID
let priorUsers = []
try {
  for (let segment = -1; segment < 4; segment++) {
    const launch = { segment, errors: [], closed: false }
    result.launches.push(launch)
    let desktop, page, child
    try {
      desktop = await _electron.launch({
        executablePath: binding.executable,
        args: ["--user-data-dir=" + profile, "--lang=zh-CN"],
        env,
        timeout: 90000,
      })
      child = desktop.process()
      launch.pid = child.pid
      launch.runtime = await desktop.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        version: app.getVersion(),
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        home: app.getPath("home"),
        documents: app.getPath("documents"),
      }))
      assert.equal(launch.runtime.packaged, true)
      assert.equal(launch.runtime.version, binding.version)
      launch.runtime.asarSHA256 = createHash("sha256")
        .update(await readFile(launch.runtime.appPath))
        .digest("hex")
      assert.equal(launch.runtime.asarSHA256, binding.asarSHA256)
      for (const dir of [launch.runtime.userData, launch.runtime.home, launch.runtime.documents])
        assert(
          resolve(dir)
            .toLowerCase()
            .startsWith(root.toLowerCase() + "\\"),
          "isolated app paths",
        )
      page = await desktop.firstWindow({ timeout: 90000 })
      page.setDefaultTimeout(30000)
      page.on("pageerror", (error) => launch.errors.push({ name: error.name, message: error.message.slice(0, 300) }))
      await page.locator('[data-component="desktop-sidebar-v2"]').waitFor({ state: "visible", timeout: 90000 })
      if (segment === -1) {
        await page
          .locator('[data-component="prompt-input"][contenteditable="true"]')
          .waitFor({ state: "visible", timeout: 90000 })
        launch.bootstrap = true
      }
      if (segment >= 0) {
        if (segment > 0) {
          const tab = page
            .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
            .filter({ has: page.locator(`a[href*="${sessionID}"]`) })
          await tab.click()
          await page
            .locator('[data-slot="session-turn-assistant-content"]')
            .getByText(result.turns.at(-1).answer, { exact: false })
            .last()
            .waitFor({ state: "visible" })
          launch.restoredSession = sessionID
        }
        const database = new DatabaseSync(join(profile, "desktop", "backend", "data", "zaovra", "zaovra.db"), {
          readOnly: true,
        })
        try {
          for (const step of steps.filter((step) => step.segment === segment)) {
            const item = { ...step, approvals: [], pass: false }
            result.turns.push(item)
            const beforeRequests = await relayRequests()
            try {
              await runTurn(page, database, launch.runtime, item)
            } finally {
              // Capture physical sends before the next input, including failed or deliberately stopped turns.
              const afterRequests = await relayRequests()
              assert.deepEqual(afterRequests.slice(0, beforeRequests.length), beforeRequests)
              item.relayRequests = afterRequests.slice(beforeRequests.length)
            }
            const sessions = database.prepare("select id from session where parent_id is null").all()
            assert.equal(sessions.length, 1)
            if (!sessionID) sessionID = sessions[0].id
            assert.equal(sessions[0].id, sessionID, "one Session through all restarts")
            const rows = messages(database)
            const users = rows.filter((row) => row.type === "user")
            assert.equal(users.length, step.index + 1)
            assert.deepEqual(
              users.map((row) => row.data.text),
              steps.slice(0, step.index + 1).map((step) => step.prompt),
            )
            assert.deepEqual(users.slice(0, -1), priorUsers, "prior durable user messages unchanged")
            priorUsers = users
            assert.equal(Object.values(database.prepare("pragma quick_check").get())[0], "ok")
            assert.equal(database.prepare("select count(*) as count from memory_note").get().count, 0)
            assert.equal(database.prepare("select count(*) as count from memory_automatic_run").get().count, 0)
            item.sessionID = sessionID
            item.users = users.length
            item.pass = true
            await writeFile(join(root, `turn-${step.index}-messages.json`), JSON.stringify(rows, null, 2))
            const screenshot = { path: join(root, `turn-${step.index}.png`) }
            try {
              await page.screenshot(screenshot)
            } catch (error) {
              if (error.name !== "TimeoutError" || page.isClosed()) throw error
              item.screenshotTimeout = { message: error.message, at: Date.now() }
              await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
              // Retry only the capture on this page. Never resubmit a completed turn.
              await page.screenshot(screenshot)
            }
            await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
          }
        } finally {
          database.close()
        }
      }
    } finally {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(root, `segment-${segment}-final.png`) }).catch(() => {})
        await writeFile(
          join(root, `segment-${segment}-ui.txt`),
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        )
      }
      if (desktop) {
        launch.processes = await desktop
          .evaluate(({ app }) => app.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type })))
          .catch(() => [])
        await desktop.close()
        launch.exit = { code: child.exitCode, signal: child.signalCode }
        launch.closed = child.exitCode === 0 && child.signalCode === null
        const remaining = () =>
          launch.processes.filter((p) => {
            try {
              process.kill(p.pid, 0)
              return true
            } catch {
              return false
            }
          })
        const deadline = Date.now() + 5000
        while (remaining().length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
        launch.remaining = remaining()
        assert.equal(launch.remaining.length, 0, "all prior app/backend processes closed before restart")
      }
      await writeFile(join(root, "result-in-progress.json"), JSON.stringify(result, null, 2))
    }
    assert(launch.closed)
    assert.equal(launch.errors.length, 0)
    if (segment === -1) {
      assert.deepEqual(JSON.parse(await readFile(join(profile, "desktop", "backend", "upgrade.json"), "utf8")), {
        version: 1,
        channel: "beta",
        action: "empty",
      })
      await mkdir(config, { recursive: true })
      await writeFile(join(config, "zaovra.json"), modelConfig, { flag: "wx" })
    }
  }
  assert.equal(result.turns.length, 17)
  assert.equal(result.turns.filter((turn) => turn.mode === "stop" && turn.stopObserved).length, 3)
  assert.equal(result.turns.filter((turn) => turn.mode === "error" && turn.errorObserved).length, 3)
  assert.equal(result.launches.filter((launch) => launch.restoredSession === sessionID).length, 3)
  result.pass = true
} catch (error) {
  result.failure = { name: error.name, message: String(error.message).slice(0, 1800) }
  process.exitCode = 1
} finally {
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, turns: result.turns.length, failure: result.failure }))
}

function messages(database) {
  return database
    .prepare("select id,type,seq,data from session_message order by seq")
    .all()
    .map((row) => ({ ...row, data: JSON.parse(row.data) }))
}

async function relayRequests() {
  if (!binding.relayJournal) return []
  return (await readFile(binding.relayJournal, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((row) => row.phase === "admitted")
    .map((row) => row.id)
}

async function runTurn(page, database, runtime, item) {
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.waitFor({ state: "visible", timeout: 90000 })
  await page.waitForFunction(
    (model) =>
      [...document.querySelectorAll('[data-action="prompt-model"]')].some((node) => node.textContent?.includes(model)),
    binding.model,
    { timeout: 90000 },
  )
  const project = join(runtime.documents, "Zaovra 项目")
  const artifact = join(project, "beta-proof.txt")
  const before = item.index === 0 ? undefined : await readFile(artifact)
  await input.fill(item.prompt)
  await page.locator('[data-action="prompt-submit"]').click()
  const started = Date.now()
  while (true) {
    assert(Date.now() - started < 240000, "recovery turn observation deadline exceeded")
    const rows = messages(database)
    const boundary = rows.findLastIndex((row) => row.type === "user" && row.data.text === item.prompt)
    assert(
      boundary >= 0 || Date.now() - started < 15000,
      "UI submit did not admit the prompt within 15 seconds; do not resend",
    )
    const current = boundary < 0 ? [] : rows.slice(boundary + 1).filter((row) => row.type === "assistant")
    const tools = current.flatMap((row) => row.data.content ?? []).filter((part) => part.type === "tool")
    const failed = current.find((row) => row.data.finish === "interrupted" || row.data.finish === "error")
    const stop = page.locator('[data-action="prompt-stop"], [data-action="prompt-submit"][aria-label="Stop"]')
    if (failed) {
      item.terminal = {
        finish: failed.data.finish,
        termination: failed.data.termination,
        observedAfterMs: Date.now() - started,
      }
      assert(
        item.mode === "stop" &&
          item.stopRequested &&
          failed.data.finish === "interrupted" &&
          failed.data.termination?.source === "user",
        "unexpected failed terminal",
      )
      if (!(await stop.isVisible())) {
        item.stopObserved = true
        assert.equal(tools.length, 0, "stopped explanation must not mutate files via tools")
        break
      }
    }
    if (item.mode === "stop" && !item.stopRequested) {
      // Streaming text is rendered before it is persisted. Scope to this user turn so old output cannot trigger Stop.
      const text =
        boundary < 0
          ? ""
          : (
              await page
                .locator(
                  `[data-message-id="${rows[boundary].id}"][data-timeline-row="AssistantPart"] [data-slot="session-turn-assistant-content"][data-streaming="true"] [data-component="markdown"]`,
                )
                .allTextContents()
            ).join("")
      item.stopObservation ??= { samples: 0, maxStreamingCharacters: 0 }
      item.stopObservation.samples++
      item.stopObservation.maxStreamingCharacters = Math.max(item.stopObservation.maxStreamingCharacters, text.length)
      if (text.length > 20 && current.length > 0 && !current.at(-1)?.data.finish && (await stop.isVisible())) {
        item.stopRequested = {
          afterMs: Date.now() - started,
          observedText: text.slice(0, 300),
          characters: text.length,
        }
        await stop.click()
      }
      assert(current.at(-1)?.data.finish !== "stop", "provider completed before a real Stop could be exercised")
    }
    const dock = page.locator('[data-notification-target^="permission:"]')
    if (item.mode !== "stop" && (await dock.isVisible())) {
      const id = await dock.getAttribute("data-notification-target")
      if (!item.approvals.some((entry) => entry.id === id && entry.approved)) {
        const permission = await dock.locator('[data-slot="permission-details"] > code').textContent()
        const patterns = await dock.locator('[data-slot="permission-patterns"] code').allTextContents()
        // Parallel bash calls can wait together; attribute the visible permission by its exact command.
        const matches = tools.filter(
          (part) =>
            part.name === "bash" &&
            part.state.status === "running" &&
            permission === "bash" &&
            patterns.length === 1 &&
            part.state.input.command === patterns[0],
        )
        assert.equal(matches.length, 1, "permission requires exactly one matching running bash")
        const tool = matches[0]
        const command = tool.state.input.command
        const workdir = resolve(project, tool.state.input.workdir ?? ".")
        const scoped =
          permission === "bash" &&
          patterns.length === 1 &&
          patterns[0] === command &&
          workdir.toLowerCase() === resolve(project).toLowerCase()
        const decisions = binding.manualApprovalFile
          ? JSON.parse(await readFile(binding.manualApprovalFile, "utf8"))
          : []
        assert(Array.isArray(decisions))
        const approved =
          scoped &&
          ((item.mode === "error" && command === item.command) ||
            (binding.approvedCommands ?? []).includes(command) ||
            decisions.some(
              (entry) =>
                entry.id === id &&
                entry.permission === permission &&
                entry.command === command &&
                entry.workdir === workdir &&
                entry.response === "once",
            ))
        const previous = item.approvals.findIndex((entry) => entry.id === id)
        const entry = { id, permission, patterns, command, workdir, approved }
        if (previous < 0 || item.approvals[previous].approved !== approved)
          await appendFile(
            join(root, `turn-${item.index}-approval-events.jsonl`),
            JSON.stringify({ ...entry, at: Date.now() }) + "\n",
          )
        item.approvals[previous < 0 ? item.approvals.length : previous] = entry
        await writeFile(join(root, `turn-${item.index}-approvals.json`), JSON.stringify(item.approvals, null, 2))
        assert(scoped && (approved || binding.manualApprovalFile), "unreviewed shell command")
        if (approved) await dock.getByRole("button", { name: /^(允许一次|Allow once)$/, exact: true }).click()
      }
    }
    if (
      item.mode !== "stop" &&
      current.at(-1)?.data.finish === "stop" &&
      !(await stop.isVisible()) &&
      (await page
        .locator('[data-slot="session-turn-assistant-content"]')
        .getByText(item.answer, { exact: false })
        .last()
        .isVisible())
    ) {
      if (item.read || item.mode === "read")
        assert(
          tools.some((tool) => tool.name === "read" && tool.state.status === "completed"),
          "read occurs in this user turn",
        )
      if (item.mode === "write")
        assert(
          tools.some(
            (tool) => ["write", "edit", "apply_patch", "bash"].includes(tool.name) && tool.state.status === "completed",
          ),
          "this turn performed a successful mutation tool",
        )
      if (item.mode === "error") {
        const errors = tools.filter(
          (tool) =>
            tool.name === "bash" &&
            tool.state.structured?.exit === 7 &&
            item.approvals.some((entry) => entry.approved && entry.command === tool.state.input?.command),
        )
        assert.equal(errors.length, 1, "one actual exit7 tool error, not a simulated statement")
        assert.equal(tools.length, 1, "no repair or repeated tool execution during deliberate error")
        item.errorObserved = {
          toolID: errors[0].id,
          command: errors[0].state.input.command,
          status: errors[0].state.status,
          exit: 7,
        }
      }
      item.successfulTerminal = current.at(-1).id
      break
    }
    // A short real response can finish between ordinary tool or file polls. Match the renderer cadence for Stop.
    await new Promise((done) => setTimeout(done, item.mode === "stop" && !item.stopRequested ? 16 : 200))
  }
  const bytes = await readFile(artifact)
  assert.equal(bytes.toString().replace(/\r?\n$/, ""), item.value, "actual file matches this turn's expected value")
  if (item.mode !== "write") assert.deepEqual(bytes, before, "non-writing turn leaves exact bytes unchanged")
  item.artifact = { file: artifact, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  item.elapsedMs = Date.now() - started
}
