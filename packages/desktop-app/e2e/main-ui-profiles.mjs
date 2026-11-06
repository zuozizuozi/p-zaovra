import assert from "node:assert/strict"
import { mkdir, writeFile, stat, readFile, readdir } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { _electron } from "playwright-core"

// Run against an unpacked desktop artifact, never a user's installed profile.
// node e2e/first-launch.mjs <executable> <new-record-directory>
const executable = resolve(process.argv[2] ?? "")
const record = resolve(process.argv[3] ?? "")
const scenario = process.argv[4] ?? "fresh"
const seed = process.argv[5] ? resolve(process.argv[5]) : undefined
assert(scenario !== "old-project" || seed, "old-project needs a synthetic fresh-profile seed")
const existingDraft = seed
  ? new URL(
      JSON.parse(await readFile(join(seed, "draft-links.json"), "utf8"))[0],
      "https://fixture.invalid",
    ).searchParams.get("draftId")
  : undefined
const existingLayout = seed
  ? JSON.parse(await readFile(join(seed, "temp", "test-profile", "desktop", "zaovra.global.dat"), "utf8")).layout
  : undefined
assert(["fresh", "old-empty", "old-project"].includes(scenario))
assert(process.argv[2] && process.argv[3] && isAbsolute(executable) && isAbsolute(record))
assert.equal(
  await stat(record).then(
    () => true,
    () => false,
  ),
  false,
  "record/profile must be new",
)
await mkdir(record, { recursive: true })
const env = Object.fromEntries(
  ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
)
for (const [key, dir] of Object.entries({
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
})) {
  env[key] = join(record, dir)
  await mkdir(env[key], { recursive: true })
}
env.ZAOVRA_TEST_ONBOARDING = "1"
const profile = join(record, "temp", "test-profile")
const project = join(profile, "documents", scenario === "old-project" ? "Existing Project" : "Default Project")
if (scenario !== "fresh") {
  await mkdir(join(profile, "desktop"), { recursive: true })
  await writeFile(
    join(profile, "desktop", "zaovra.settings"),
    JSON.stringify({ firstLaunchOnboardingComplete: true, oldLayoutEligible: true, windowIds: ["profile-690"] }),
  )
  await mkdir(project, { recursive: true })
  await writeFile(
    join(profile, "desktop", "zaovra.global.dat"),
    JSON.stringify({
      layout:
        scenario === "old-project"
          ? '{"sidebar":{"opened":true,"width":344,"workspaces":{},"workspacesDefault":false},"terminal":{"height":280,"opened":false},"review":{"diffStyle":"split","panelOpened":false},"fileTree":{"opened":false,"width":200,"tab":"changes"},"session":{"width":600},"mobileSidebar":{"opened":false},"sessionTabs":{},"sessionView":{},"handoff":{},"home":{"selection":{"server":"sidecar"}}}'
          : undefined,
      server: JSON.stringify({
        list: [],
        projects: { local: scenario === "old-project" ? [{ worktree: project, expanded: true }] : [] },
        lastProject: scenario === "old-project" ? { local: project } : {},
        recentlyClosed: {},
      }),
    }),
  )
  if (scenario === "old-project") {
    const previous = join(seed, "temp", "test-profile", "desktop")
    for (const file of (await readdir(previous)).filter((name) => name.startsWith("zaovra.draft.")))
      await writeFile(join(profile, "desktop", file), await readFile(join(previous, file)))
  }
  if (scenario === "old-project")
    await writeFile(
      join(profile, "desktop", "zaovra.window.profile-690.dat"),
      JSON.stringify({
        tabs: JSON.stringify([{ type: "draft", draftID: existingDraft, server: "sidecar", directory: project }]),
        "tabs.recent": JSON.stringify({ key: "draft:" + existingDraft }),
      }),
    )
  await writeFile(
    join(record, "preset.json"),
    JSON.stringify(
      {
        scenario,
        profile,
        project,
        completed: true,
        oldEligible: true,
        tabs: scenario === "old-project" ? 1 : 0,
        projects: scenario === "old-project" ? 1 : 0,
      },
      null,
      2,
    ),
  )
}
const desktop = await _electron.launch({
  executablePath: executable,
  args: ["--user-data-dir=" + profile, "--lang=zh-CN"],
  env,
  timeout: 90_000,
})
const child = desktop.process()
await writeFile(join(record, "electron-start.json"), JSON.stringify({ pid: child.pid }))
const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })))
const summary = { scenario, executable, pid: child.pid, packaged: false, assertions: {}, stopped: false }
try {
  const runtime = await desktop.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath("userData"),
    documents: app.getPath("documents"),
    home: app.getPath("home"),
  }))
  Object.assign(summary, runtime)
  assert.equal(runtime.packaged, true, "must test the actual packaged artifact")
  for (const dir of [runtime.userData, runtime.documents, runtime.home]) {
    assert(resolve(dir).startsWith(record + "/") || resolve(dir).startsWith(record + "\\"), "isolated paths only")
  }
  const page = await desktop.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(90_000)
  await page.locator('[data-component="prompt-input"][contenteditable="true"]').waitFor({ state: "visible" })
  if (scenario === "old-project")
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-component="prompt-input"][contenteditable="true"]')
          ?.textContent?.includes("首启无模型保护验证"),
      null,
      { timeout: 15000 },
    )
  if (scenario === "old-project")
    assert.match(
      await page.locator('[data-component="prompt-input"][contenteditable="true"]').innerText(),
      /首启无模型保护验证/,
    )
  const sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
  summary.oldLayoutEligible = await page.evaluate(() => window.api.isOldLayoutEligible())
  summary.firstLaunchPending = await page.evaluate(() => window.api.isFirstLaunchOnboardingPending())
  if (scenario === "old-project") {
    await sidebar.waitFor({ state: "visible" })
    assert.equal(await sidebar.isVisible(), true, "preserve the existing open sidebar")
    summary.assertions.openSidebarPreferenceRetained = true
  } else {
    await sidebar.waitFor({ state: "visible" })
    assert(await sidebar.isVisible(), "main sidebar")
    assert(await sidebar.locator("svg").first().isVisible(), "ZAOVRA wordmark")
  }
  assert.match(
    await sidebar.locator('[data-slot="project-heading"]').first().innerText(),
    scenario === "old-project" ? /Existing Project/ : /Default Project/,
  )
  const draft = sidebar
    .locator('[data-slot="titlebar-tab-item"][data-active="true"]')
    .filter({ has: page.locator('a[href*="draftId="]') })
  await draft.waitFor({ state: scenario === "old-project" ? "attached" : "visible" })
  assert.equal(await draft.count(), 1, "fresh profile opens one active draft tab")
  assert.match(await draft.innerText(), /新对话|新会话|New (chat|session)/i)
  assert.match(
    await page.locator('[data-slot="new-session-task"]').innerText(),
    scenario === "old-project" ? /Existing Project/ : /Default Project/,
  )
  assert.equal(await page.getByText(/欢迎使用 Zaovra|Welcome to Zaovra|Zaovra 0\.1\.0/).count(), 0)
  assert.equal(await page.getByRole("dialog").count(), 0, "no release-notes modal")
  assert((await stat(project)).isDirectory())
  assert.equal(summary.firstLaunchPending, false)
  assert.equal(summary.oldLayoutEligible, scenario !== "fresh")
  if (scenario === "old-project") {
    assert.match(await draft.locator("a").first().getAttribute("href"), new RegExp(existingDraft))
    assert.equal(
      await stat(join(runtime.documents, "Default Project")).then(
        () => true,
        () => false,
      ),
      false,
    )
  }
  summary.assertions = {
    sidebar: true,
    logo: true,
    project: true,
    activeDraft: true,
    projectTitle: true,
    input: true,
    noWelcome: true,
    noReleaseNotes: true,
  }
  await page.screenshot({ path: join(record, "first-launch.png") })
  await writeFile(join(record, "visible-ui.txt"), await page.locator("body").innerText())
  await writeFile(
    join(record, "draft-links.json"),
    JSON.stringify(
      await draft.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      null,
      2,
    ),
  )
  await writeFile(
    join(record, "buttons.json"),
    JSON.stringify(await page.getByRole("button").allTextContents(), null, 2),
  )
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("首启无模型保护验证")
  await input.press("Enter")
  await page.getByText("所选模型当前不可用", { exact: true }).waitFor({ state: "visible" })
  assert.match(await input.innerText(), /首启无模型保护验证/)
  summary.assertions.noModelSendPrompt = true
  await page.screenshot({ path: join(record, "no-model-send.png") })
  if (scenario === "old-project") {
    await page.keyboard.press("Control+,")
    await page.getByRole("tab", { name: "关于 Zaovra", exact: true }).click()
    await page.getByText("© 2026 Zaovra", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await page.getByRole("button", { name: "开源许可", exact: true }).count(), 0)
    await page.screenshot({ path: join(record, "about.png") })
    await page.getByRole("button", { name: "第三方声明", exact: true }).click()
    await page.getByText(/Copyright \(c\) 2025 opencode/).waitFor({ state: "visible" })
    assert.match(await page.locator("pre").innerText(), /Permission is hereby granted/)
    await page.screenshot({ path: join(record, "third-party.png") })
    summary.assertions.aboutProprietary = true
    summary.assertions.upstreamMITRetained = true
  }
} finally {
  try {
    const page = desktop.windows()[0]
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(record, "first-launch-final.png") })
      await writeFile(join(record, "visible-ui-final.txt"), await page.locator("body").innerText())
    }
    const processes = await desktop.evaluate(({ app }) =>
      app.getAppMetrics().map((item) => ({ pid: item.pid, type: item.type })),
    )
    await writeFile(join(record, "processes.json"), JSON.stringify(processes, null, 2))
    if (process.env.ZAOVRA_FIRST_LAUNCH_TRACK_OWNERSHIP === "1") {
      const deadline = Date.now() + 5_000
      while (
        !(await stat(join(record, "processes-ack.json")).then(
          () => true,
          () => false,
        ))
      ) {
        assert(Date.now() < deadline, "ownership recorder acknowledgement")
        await new Promise((done) => setTimeout(done, 25))
      }
    }
  } finally {
    await desktop.close()
    summary.exit = await exited
    summary.stopped = true
    await writeFile(join(record, "result.json"), JSON.stringify(summary, null, 2) + "\n")
  }
}
assert.equal(summary.exit.signal, null)
assert.equal(summary.exit.code, 0)
console.log(JSON.stringify({ packaged: summary.packaged, assertions: summary.assertions, exit: summary.exit }))
