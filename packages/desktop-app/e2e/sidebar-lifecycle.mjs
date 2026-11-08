import assert from "node:assert/strict"
import { mainPath } from "./main-path.mjs"

export async function sidebarLifecycle(options) {
  const started = performance.now()
  const run = await mainPath(options)
  const result = {
    scope: "742 sidebar lifecycle",
    source: options.source,
    mode: options.verify ? "acceptance" : "baseline",
    samples: options.animationEvidence?.samples ?? [],
    reusedAnimationEvidence: options.animationEvidence?.file,
    metrics: {},
    screenshots: [],
  }
  let reopened
  try {
    await options.onRuntime?.(run)
    await run.fresh()
    result.metrics.readyMs = performance.now() - started
    await run.connect()
    await run.page.emulateMedia({ reducedMotion: "no-preference" })
    const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.fill("MP4：742侧栏完成与动画")
    const promptAt = performance.now()
    await input.press("Enter")
    await run.page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "visible" })
    result.metrics.firstTextMs = performance.now() - promptAt
    const active = run.page.locator(
      '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
    )
    const session = /ses_[a-zA-Z0-9]+/.exec((await active.getAttribute("href")) ?? "")?.[0]
    assert(session, "visible Session identity")
    result.session = session
    result.url = run.page.url()
    const row = run.page
      .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
      .filter({ has: run.page.locator('a[href*="' + session + '"]') })
    await row.getByText("进行中", { exact: true }).waitFor({ state: "visible", timeout: 5000 })
    const ring = row.locator('[data-slot="session-running-ring"]')
    await ring.waitFor({ state: "visible" })
    for (let i = 0; i < (options.animationEvidence ? 0 : 3); i++) {
      result.samples.push(
        await ring.evaluate((element) => ({
          at: performance.now(),
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          animationName: getComputedStyle(element).animationName,
          animationDuration: getComputedStyle(element).animationDuration,
          animationPlayState: getComputedStyle(element).animationPlayState,
          transform: getComputedStyle(element).transform,
          animations: element.getAnimations().map((a) => ({ currentTime: a.currentTime, playState: a.playState })),
        })),
      )
      if (i < 2) {
        await run.capture("742-running-frame-" + i)
        result.screenshots.push("742-running-frame-" + i + ".jpg")
      }
      await run.page.waitForTimeout(180)
    }
    if (options.verify && !options.skipReduced) {
      await run.page.emulateMedia({ reducedMotion: "reduce" })
      await run.page.waitForTimeout(80)
      result.reducedMotion = await ring.evaluate((element) => ({
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        animationName: getComputedStyle(element).animationName,
        status: element.closest('[role="img"]')?.getAttribute("aria-label"),
      }))
      assert(
        result.reducedMotion.reduced && result.reducedMotion.animationName === "none",
        "reduced motion remains static",
      )
      assert(result.reducedMotion.status === "执行中", "reduced motion retains accessible working state")
      await run.capture("742-reduced-motion")
      result.screenshots.push("742-reduced-motion.jpg")
      await run.page.emulateMedia({ reducedMotion: "no-preference" })
    }
    await run.page.getByRole("button", { name: "新对话", exact: true }).last().click()
    await run.page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "hidden" })
    let disconnected = options.disconnect === true
    result.ownershipFaults = 0
    if (options.disconnect)
      await run.page.route("**/api/session/active", (route) => {
        if (!disconnected) return route.continue()
        result.ownershipFaults++
        return route.abort("failed")
      })
    const restore = options.disconnect
      ? setTimeout(() => {
          disconnected = false
        }, 350)
      : undefined
    const ended = performance.now()
    run.control.stream.resolve()
    result.background = []
    while (performance.now() - ended < 5000) {
      const label = await row.innerText()
      result.background.push({ elapsedMs: performance.now() - ended, label })
      if (!label.includes("进行中")) {
        result.metrics.backgroundIdleMs = performance.now() - ended
        break
      }
      await run.page.waitForTimeout(80)
    }
    if (restore) clearTimeout(restore)
    result.backgroundFinal = await row.innerText()
    await run.capture("742-background-complete")
    result.screenshots.push("742-background-complete.jpg")
    const entered = performance.now()
    await row.locator('[data-slot="tab-link"]').click()
    await run.page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "visible" })
    while (performance.now() - entered < 2000) {
      if (!/待看|进行中/.test(await row.innerText())) {
        result.metrics.enterClearMs = performance.now() - entered
        break
      }
      await run.page.waitForTimeout(50)
    }
    result.enterFinal = await row.innerText()
    await run.capture("742-entered")
    result.screenshots.push("742-entered.jpg")
    result.profile = run.report.profile
    result.runtime = run.report.runtime
    await run.close()
    const restartAt = performance.now()
    reopened = await mainPath({ ...options, record: options.reopenRecord, profile: result.profile })
    await options.onRuntime?.(reopened)
    await reopened.page
      .locator('[data-component="prompt-input"][contenteditable="true"]')
      .waitFor({ state: "visible", timeout: 90000 })
    const reopenedRow = reopened.page
      .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
      .filter({ has: reopened.page.locator('a[href*="' + session + '"]') })
    await reopenedRow.waitFor({ state: "visible", timeout: 10000 })
    await reopened.page.waitForTimeout(300)
    result.metrics.restartReadyMs = performance.now() - restartAt
    result.reopenFinal = await reopenedRow.innerText()
    result.reopenRingCount = await reopenedRow.locator('[data-slot="session-running-ring"]').count()
    await reopened.capture("742-reopened")
    result.reopenRuntime = reopened.report.runtime
    if (options.disconnect) assert(result.ownershipFaults > 0, "actual final ownership response failed")
    if (options.expectStale)
      assert(
        result.backgroundFinal.includes("进行中"),
        "original background status remains stale after controlled lost ownership checks",
      )
    if (options.verify) {
      assert(
        result.samples.every((x) => !x.reduced && x.animationName !== "none" && x.animationPlayState === "running"),
        "normal-motion ring has a running animation",
      )
      assert(
        new Set(result.samples.map((x) => x.transform)).size > 1,
        "ring visibly rotates across consecutive samples",
      )
      assert(
        result.metrics.backgroundIdleMs !== undefined && result.metrics.backgroundIdleMs <= 2000,
        "background completion clears running within2s",
      )
      assert(result.backgroundFinal.includes("待看"), "background completion becomes unread")
      assert(
        !result.enterFinal.includes("进行中") && !result.enterFinal.includes("待看"),
        "entry clears unread without retaining running",
      )
      assert(
        !result.reopenFinal.includes("进行中") && !result.reopenFinal.includes("待看") && result.reopenRingCount === 0,
        "restart retains completed and viewed state",
      )
    }
    result.ok = true
  } catch (error) {
    result.error = String(error)
    result.stack = error.stack
    await (reopened ?? run).capture("742-lifecycle-failure").catch(() => {})
  } finally {
    await run.close().catch((error) => {
      result.closeError = String(error)
    })
    await reopened?.close().catch((error) => {
      result.reopenCloseError = String(error)
    })
    result.firstRun = run.report
    result.reopenRun = reopened?.report
    await options.onResult?.(result)
  }
  if (!result.ok || result.closeError || result.reopenCloseError)
    throw new Error(result.error ?? result.closeError ?? result.reopenCloseError)
  return result
}
