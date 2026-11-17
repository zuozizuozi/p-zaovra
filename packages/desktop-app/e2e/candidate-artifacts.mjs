import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { join, resolve } from "node:path"
import { _electron } from "playwright-core"

// The launch binding contains only a loopback credential, never an upstream key.
const binding = JSON.parse(await readFile(process.argv[2], "utf8"))
const root = resolve(binding.output)
const profileRoot = binding.restoreFrom ? resolve(binding.restoreFrom) : root
if (binding.restoreFrom) {
  assert(profileRoot.startsWith(resolve("F:/Zaovra-研发记录/逐次记录") + "\\"))
  assert.notEqual(profileRoot, root, "restore evidence must use a fresh output directory")
  const previous = JSON.parse(await readFile(join(profileRoot, "result.json"), "utf8"))
  assert(previous.phases.some((phase) => phase.phase === "artifacts" && phase.pass && phase.closed))
  assert(
    previous.phases.every((phase) => phase.closed),
    "previous test instances must have closed",
  )
}
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
  env[key] = join(profileRoot, leaf)
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
const profile = join(profileRoot, "temp", "profile")
const config = join(profile, "desktop", "backend", "config", "zaovra")
const modelConfig = JSON.stringify(
  {
    model: `candidate/${binding.model}`,
    enabled_providers: ["candidate"],
    snapshot: false,
    shell: "powershell",
    permission: {
      "*": "allow",
      bash: "allow",
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

// Only the provider is scripted. Artifact generation, verification, publication and UI use the packaged application.
const result = {
  sourceSHA: binding.sourceSHA,
  version: binding.version,
  restoreFrom: binding.restoreFrom,
  phases: [],
  pass: false,
}
const complete = binding.commands
  ? `ARTIFACT_DELIVERY: 先完成 ${binding.commands} 个独立脚本步骤，每步在 .history-fixture 中保存对应结果，再运行 generate.mjs 直接生成 PDF、PNG、SVG 并列出成果。不调用 write 或 publish_artifact。`
  : binding.direct
    ? "ARTIFACT_DELIVERY: 用项目中的脚本直接生成 PDF、PNG、SVG 并列出成果，不调用 write 或 publish_artifact。old.pdf 是旧参考文件，不是本轮新成果。"
    : "ARTIFACT_DELIVERY: 用项目中的生成和校验脚本生成 PDF、PNG、SVG 三个候选，运行真实检查，再用同一检查依次发布三个文件，最后列出成果。"
try {
  for (const phase of binding.restoreFrom ? ["restore"] : ["bootstrap", "artifacts", "restore"]) {
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
            .startsWith(profileRoot.toLowerCase() + "\\"),
        )
      page = await desktop.firstWindow({ timeout: 90000 })
      item.messagePages = []
      page.on("response", async (response) => {
        if (!/\/api\/session\/[^/]+\/messages?(\?|$)/.test(response.url())) return
        const body = await response.json().catch(() => undefined)
        if (!body?.data || !Array.isArray(body.data)) return
        item.messagePages.push({
          url: response.url(),
          count: body.data.length,
          next: !!body.cursor?.next,
          types: body.data.map((message) => message.type),
        })
      })
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
      const project = join(item.runtime.documents, "Zaovra 项目")
      if (phase === "artifacts") {
        if (binding.commands) await mkdir(join(project, ".history-fixture"), { recursive: true })
        await writeFile(join(project, "generate.mjs"), await readFile(binding.generator))
        if (binding.direct) {
          await writeFile(
            join(project, "generate.mjs"),
            (await readFile(binding.generator, "utf8")) +
              '\nconst {rename} = await import("node:fs/promises"); for (const name of ["proof.pdf", "proof.png", "proof.svg"]) await rename(name + ".candidate", name);',
          )
          await writeFile(join(project, "old.pdf"), await readFile(binding.pdf))
        }
        await writeFile(join(project, "check.mjs"), await readFile(binding.checker))
        await writeFile(join(project, "fixture.pdf"), await readFile(binding.pdf))
        await submit(page, complete)
        await until(
          () =>
            rows(db).some(
              (row) =>
                row.type === "assistant" &&
                row.data.finish === "stop" &&
                row.data.content.some((part) => part.type === "text" && part.text.includes("ARTIFACT_DONE")),
            ),
          "delivery completes",
          binding.commands ? 5400000 : 60000,
        )
      }
      const tools = rows(db)
        .flatMap((row) => (row.type === "assistant" ? row.data.content : []))
        .filter((part) => part.type === "tool")
      item.tools = tools.map((part) => ({
        name: part.name,
        id: part.id,
        status: part.state.status,
        structured: part.state.structured,
      }))
      await writeFile(join(root, "messages.json"), JSON.stringify(rows(db), null, 2))
      assert.deepEqual(
        tools.map((part) => [part.name, part.state.status]),
        binding.direct
          ? Array.from({ length: (binding.commands ?? 0) + 1 }, () => ["bash", "completed"])
          : [
              ["bash", "completed"],
              ["bash", "completed"],
              ...Array.from({ length: 3 }, () => ["publish_artifact", "completed"]),
            ],
      )
      if (binding.commands) {
        const messages = rows(db)
        const user = messages.filter((message) => message.type === "user")
        assert.equal(user.length, 1, "one human turn; command records must not become new prompts")
        assert(messages.length > 270, "history exceeds initial page plus five automatic older pages")
        assert(messages.filter((message) => message.type === "shell").length >= binding.commands)
        assert(
          messages.every((message) => message.data.turn === user[0].id),
          "durable command and reply ownership is preserved",
        )
        item.history = {
          count: messages.length,
          userID: user[0].id,
          shellCount: messages.filter((message) => message.type === "shell").length,
        }
        if (binding.restoreFrom) {
          const snapshot = item.messagePages.find((page) => new URL(page.url).searchParams.get("boundary") === "turn")
          assert(snapshot, "cold open requests a turn page")
          assert.equal(snapshot.count, messages.length, "one chronological user turn is loaded completely")
          assert(snapshot.types.includes("user"), "cold snapshot includes the real user")
        }
        for (let step = 0; step < binding.commands; step++)
          assert.equal(await readFile(join(project, ".history-fixture", `step_${step}.txt`), "utf8"), `STEP_${step}`)
      }
      if (!binding.direct) {
        const checks = tools[1].state.structured.verification
        assert(checks && checks.exit === 0 && checks.targets.length >= 4)
      }
      item.files = []
      for (const name of ["proof.pdf", "proof.png", "proof.svg"]) {
        const bytes = await readFile(join(project, name))
        const receipt = tools.find(
          (part) => part.name === "publish_artifact" && part.state.structured.path.endsWith(name),
        )
        const digest = createHash("sha256").update(bytes).digest("hex")
        if (!binding.direct) {
          assert(receipt)
          assert.equal(receipt.state.structured.digest, digest)
        }
        assert.equal(
          await stat(join(project, name + ".candidate")).then(
            () => true,
            () => false,
          ),
          false,
        )
        item.files.push({ name, bytes: bytes.length, digest })
      }
      await page.getByText("ARTIFACT_DONE", { exact: false }).last().waitFor({ state: "visible" })
      await page.screenshot({ path: join(root, "delivery-cards.png") })
      item.links = await page
        .locator("a")
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => /proof\.(pdf|png|svg)/.test(node.textContent ?? ""))
            .map((node) => ({ text: node.textContent, href: node.getAttribute("href") })),
        )
      await writeFile(join(root, "delivery-ui.txt"), await page.locator("body").innerText())
      const cards = page.locator('[data-component="turn-deliverables"]')
      await cards.waitFor({ state: "visible" })
      assert.equal(await cards.locator("li").count(), 3, "all three files have real delivery cards")
      item.previews = []
      for (const name of ["proof.pdf", "proof.png", "proof.svg"]) {
        const card = cards.locator("li").filter({ hasText: name })
        await card.getByRole("button", { name: "成果预览", exact: true }).click()
        const panel = page.locator('[data-component="artifact-preview-panel"]:visible')
        await panel.waitFor({ state: "visible" })
        await panel.getByRole("tab", { name, exact: true }).waitFor({ state: "visible" })
        if (name.endsWith(".pdf")) {
          const canvas = panel.locator('canvas[data-rendered="1"]')
          await canvas.waitFor({ state: "visible" })
          const image = await canvas.evaluate((node) => {
            const data = node.getContext("2d").getImageData(0, 0, node.width, node.height).data
            const pixels = new Set()
            for (let at = 0; at < data.length; at += 4) pixels.add(`${data[at]},${data[at + 1]},${data[at + 2]}`)
            return { width: node.width, height: node.height, colors: pixels.size }
          })
          assert(
            image.width > 100 && image.height > 100 && image.colors > 2,
            "PDF canvas contains rendered fixture pixels",
          )
          item.previews.push({ name, ...image })
        } else {
          let observed
          await until(async () => {
            observed = await desktop.evaluate(async ({ webContents }, name) => {
              const view = webContents
                .getAllWebContents()
                .find((view) => view.getURL().startsWith("oc://artifact-") && view.getURL().endsWith("/" + name))
              if (!view) return undefined
              return view.executeJavaScript(
                "({ready:document.readyState,image:document.querySelector('img')?{complete:document.querySelector('img').complete,width:document.querySelector('img').naturalWidth,height:document.querySelector('img').naturalHeight}:null,svg:document.querySelector('svg')?{width:document.querySelector('svg').getAttribute('width'),height:document.querySelector('svg').getAttribute('height'),text:document.querySelector('svg').textContent}:null})",
              )
            }, name)
            return (
              observed?.ready === "complete" &&
              (name.endsWith(".png")
                ? observed.image?.complete && observed.image.width === 64 && observed.image.height === 48
                : observed.svg?.text.includes("ARTIFACT SVG"))
            )
          }, "actual artifact view decodes " + name)
          item.previews.push({ name, ...observed })
          const bytes = await desktop.evaluate(async ({ webContents }, name) => {
            const view = webContents
              .getAllWebContents()
              .find((view) => view.getURL().startsWith("oc://artifact-") && view.getURL().endsWith("/" + name))
            return (await view.capturePage()).toPNG().toString("base64")
          }, name)
          await writeFile(join(root, phase + "-" + name + "-view.png"), Buffer.from(bytes, "base64"))
        }
        await page.screenshot({ path: join(root, phase + "-" + name + "-window.png") })
        await panel.getByRole("button", { name: "关闭", exact: true }).click()
        await panel.waitFor({ state: "hidden" })
      }
      if (binding.commands) {
        await page.mouse.move(700, 350)
        await page.mouse.wheel(0, -100000)
        await page.getByText(complete, { exact: true }).waitFor({ state: "visible", timeout: 30000 })
        assert.equal((await page.locator(`[data-message-id="${item.history.userID}"]`).count()) > 0, true)
        item.humanPromptVisible = true
        await page.screenshot({ path: join(root, phase + "-human-prompt.png") })
      }
      assert.equal(db.prepare("select count(*) as n from memory_note").get().n, 0)
      assert.equal(Object.values(db.prepare("pragma quick_check").get())[0], "ok")
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
