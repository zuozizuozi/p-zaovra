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
            // Imported custom models may omit image capabilities entirely.
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

// Only the provider is scripted. Image settings, attachments and cold-start restore use the packaged application.
const result = { sourceSHA: binding.sourceSHA, version: binding.version, phases: [], pass: false }
try {
  for (const phase of ["bootstrap", "toggle", "restore-enabled", "restore-disabled"]) {
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
      const image = binding.image
      const capture = async (name) => {
        const bytes = await desktop.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
          return (await window.webContents.capturePage()).toPNG().toString("base64")
        })
        assert(bytes.length > 1000, "native capture contains pixels")
        await writeFile(join(root, name + ".png"), Buffer.from(bytes, "base64"))
      }
      item.sends = []
      const sendImage = async (marker, enabled) => {
        await page.locator('input[type="file"]').first().setInputFiles(image)
        await page
          .locator('[data-component="prompt-input"] img, [data-slot="prompt-attachments"] img')
          .first()
          .waitFor({ state: "visible" })
        await submit(page, marker + ": 请检查附图。")
        await until(
          () =>
            rows(db).some(
              (row) =>
                row.type === "assistant" &&
                row.data.finish === "stop" &&
                row.data.content.some((part) => part.type === "text" && part.text.includes(marker + "_DONE")),
            ),
          "image turn finishes",
        )
        await page
          .getByText(marker + "_DONE", { exact: false })
          .last()
          .waitFor({ state: "visible" })
        const receipts = JSON.parse(await readFile(binding.receipts, "utf8"))
        const receipt = receipts.findLast((entry) => entry.marker === marker)
        assert(receipt)
        assert.equal(
          receipt.images.length,
          enabled ? 1 : 0,
          "effective image capability controls actual wire image content",
        )
        if (enabled)
          assert.equal(
            receipt.images[0].sha256,
            createHash("sha256")
              .update(await readFile(image))
              .digest("hex"),
          )
        item.sends.push(receipt)
        await capture(marker)
      }
      const configure = async (before, after) => {
        await page.keyboard.press("Control+,")
        await page.getByRole("tab", { name: "模型服务", exact: true }).click()
        const provider = page
          .locator('[data-component="connected-providers-section"] .settings-v2-provider-row')
          .filter({ hasText: "Isolated candidate validation" })
        await provider.getByRole("button", { name: "配置模型", exact: true }).click()
        const checkbox = page.locator('[data-component="model-image-input"]').getByRole("checkbox")
        await checkbox.waitFor({ state: "visible" })
        assert.equal(await checkbox.isChecked(), before)
        if (before !== after) {
          await checkbox.setChecked(after)
          await page.getByRole("button", { name: "保存模型", exact: true }).click()
          await until(async () => {
            const saved = JSON.parse(await readFile(join(config, "zaovra.jsonc"), "utf8").catch(() => "{}"))
            return saved.provider?.candidate?.models?.[binding.model]?.modalities?.input?.includes("image") === after
          }, "image capability saved to actual backend config")
        }
        await capture(phase + "-models")
        await page.keyboard.press("Escape")
        await page.locator(".settings-v2-page").getByRole("button", { name: "关闭", exact: true }).click()
        await input.waitFor({ state: "visible" })
      }
      if (phase === "toggle") {
        await sendImage("IMAGE_OFF", false)
        await configure(false, true)
        await sendImage("IMAGE_ON", true)
      }
      if (phase === "restore-enabled") {
        await configure(true, true)
        await sendImage("IMAGE_RESTORED_ON", true)
        await configure(true, false)
        await sendImage("IMAGE_OFF_AGAIN", false)
      }
      if (phase === "restore-disabled") {
        await configure(false, false)
        await sendImage("IMAGE_RESTORED_OFF", false)
      }
      assert.equal(db.prepare("select count(*) as n from memory_note").get().n, 0)
      assert.equal(Object.values(db.prepare("pragma quick_check").get())[0], "ok")
      await writeFile(join(root, phase + "-messages.json"), JSON.stringify(rows(db), null, 2))
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
