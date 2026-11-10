import { test } from "@playwright/test"
import { usageRefreshScenario } from "../utils/usage-refresh"
;[
  { width: 1280, height: 800 },
  { width: 900, height: 720 },
].forEach((viewport) => {
  test(`usage refresh keeps composer geometry and a single click submits at ${viewport.width}px`, async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("Missing application URL")
    await page.setViewportSize(viewport)
    await usageRefreshScenario(page, baseURL)
  })
})
