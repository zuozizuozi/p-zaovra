import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"
import { mockZaovraServer } from "../../utils/mock-server"
import { installStressSessionTabs, installTimelineSettings, stressSessionHref } from "./timeline-test-helpers"

for (const projectMissing of [false, true]) {
  test(`removing an unavailable session closes its tab without deleting data (project missing: ${projectMissing})`, async ({
    page,
  }) => {
    const directory = projectMissing ? fixture.directory : "C:/Zaovra/DeletedSession"
    await mockZaovraServer(page, {
      sessions: fixture.sessions.map((session) =>
        session.id === fixture.sourceID ? { ...session, directory } : session,
      ),
      directory: fixture.directory,
      project: fixture.project,
      provider: fixture.provider,
      pageMessages,
    })
    await installTimelineSettings(page)
    await installStressSessionTabs(page, { sessionIDs: [fixture.sourceID] })
    const deleted: string[] = []
    page.on("request", (request) => {
      if (request.method() === "DELETE") deleted.push(request.url())
    })
    await page.route(`**/api/session/${fixture.sourceID}`, (route) =>
      route.fulfill({
        json: {
          data: {
            id: fixture.sourceID,
            title: "Unavailable session",
            agent: "build",
            projectID: "proj_smoke_timeline",
            location: { directory },
            time: { created: 1, updated: 1 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
          },
        },
      }),
    )
    await page.route("**/api/location*", async (route) => {
      if (![...new URL(route.request().url()).searchParams.values()].some((value) => value.includes(directory))) {
        await route.fallback()
        return
      }
      await route.fulfill({ status: 400, json: { name: "DirectoryUnavailableError", data: { directory } } })
    })
    await page.goto(stressSessionHref(fixture.sourceID))
    const remove = page.getByRole("button", { name: "Remove from list", exact: true })
    await expect(remove).toBeVisible()
    await remove.click()
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("zaovra.window.browser.dat:tabs") ?? "[]")))
      .toEqual([])
    await expect(page).not.toHaveURL(new RegExp(fixture.sourceID))
    const projects = await page.evaluate(
      () => JSON.parse(localStorage.getItem("zaovra.global.dat:server")!).projects.local,
    )
    expect(projects.some((project: { worktree: string }) => project.worktree === fixture.directory)).toBe(
      !projectMissing,
    )
    expect(deleted).toEqual([])
  })
}
