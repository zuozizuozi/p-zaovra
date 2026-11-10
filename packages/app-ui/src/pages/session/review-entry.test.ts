import { afterEach, expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createReviewEntry } from "./review-entry"
import { manualChange, reviewEntrySource, untilReviewEntry } from "./review-entry.test-helper"

const cleanups: Array<() => void> = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
)
afterEach(() => focusManager.setFocused(undefined))

async function mount(git = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000, refetchOnMount: false, refetchOnWindowFocus: false } },
  })
  const source = await reviewEntrySource()
  cleanups.push(
    () => source.stop(),
    () => queryClient.clear(),
  )
  const [state, setState] = createStore({
    directory: "F:/review-entry-a",
    scope: "server-a",
    branch: "main",
    git,
    reviewCount: 0,
    turnCount: 0,
    mode: "turn" as "git" | "branch" | "turn",
  })
  let entry!: ReturnType<typeof createReviewEntry>
  const start = () =>
    createRoot((dispose) => {
      createComponent(QueryClientProvider, {
        client: queryClient,
        get children() {
          entry = createReviewEntry({
            workspace: () => ({
              key: ["session-vcs", state.directory, state.branch, "main", state.scope],
              git: state.git,
              client: source.client(state.directory),
            }),
            reviewCount: () => state.reviewCount,
            turnCount: () => state.turnCount,
            setMode: (mode) => setState("mode", mode),
          })
          return null
        },
      })
      return dispose
    })
  let dispose = start()
  cleanups.push(() => dispose())
  return {
    source,
    state,
    setState,
    get entry() {
      return entry
    },
    queryClient,
    remount: () => {
      dispose()
      dispose = start()
    },
  }
}

test("807 cold Git bootstrap stays pending until status, then selects Git without requesting patches", async () => {
  const app = await mount()
  let release!: () => void
  app.source.set(app.state.directory, {
    files: manualChange,
    wait: new Promise<void>((resolve) => (release = resolve)),
  })
  expect(app.entry.query.isPending).toBe(true)
  expect(app.entry.hasChanges()).toBe(false)
  await untilReviewEntry(() => app.source.requests.length === 1)
  release()
  await untilReviewEntry(() => app.entry.hasChanges())
  app.entry.select()
  expect(app.state.mode).toBe("git")
  expect(app.source.requests).toEqual(["/vcs/status"])
})

test("807 non-Git never queries Git and authoritative turn changes still open Turn", async () => {
  const app = await mount(false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(app.source.requests).toEqual([])
  expect(app.entry.hasChanges()).toBe(false)
  app.setState("turnCount", 1)
  app.entry.select()
  expect(app.entry.hasChanges()).toBe(true)
  expect(app.state.mode).toBe("turn")
})

test("807 disabling Git cannot retain a cached workspace-only changes entry", async () => {
  const app = await mount()
  app.source.set(app.state.directory, { files: manualChange })
  await untilReviewEntry(() => app.entry.hasChanges())
  app.setState("git", false)
  expect(app.entry.hasChanges()).toBe(false)
  expect(app.source.requests).toEqual(["/vcs/status"])
})

test("807 reload rechecks a fresh cached empty status even when the app disables refetchOnMount", async () => {
  const app = await mount()
  await untilReviewEntry(() => app.entry.query.isSuccess)
  expect(app.entry.hasChanges()).toBe(false)
  app.source.set(app.state.directory, { files: manualChange })
  app.remount()
  await untilReviewEntry(() => app.entry.hasChanges())
  expect(app.source.requests).toEqual(["/vcs/status", "/vcs/status"])
})

test("807 preserves a selected nonempty review before falling back to a completed turn", async () => {
  const app = await mount()
  app.setState({ mode: "branch", reviewCount: 2, turnCount: 1 })
  app.entry.select()
  expect(app.state.mode).toBe("branch")
  app.setState("reviewCount", 0)
  app.entry.select()
  expect(app.state.mode).toBe("turn")
  await untilReviewEntry(() => app.entry.query.isSuccess)
})

test("807 failed status is an error, retry exposes changes, failed refresh retains known changes, clean clears them", async () => {
  const app = await mount()
  app.source.set(app.state.directory, { files: [], error: true })
  await untilReviewEntry(() => app.entry.query.isError)
  expect(app.entry.query.isSuccess).toBe(false)
  expect(app.entry.hasChanges()).toBe(false)
  app.source.set(app.state.directory, { files: manualChange })
  focusManager.setFocused(false)
  focusManager.setFocused(true)
  await untilReviewEntry(() => app.entry.query.isSuccess)
  expect(app.entry.hasChanges()).toBe(true)
  app.source.set(app.state.directory, { files: [], error: true })
  await app.entry.query.refetch()
  expect(app.entry.query.isError).toBe(true)
  expect(app.entry.hasChanges()).toBe(true)
  app.source.set(app.state.directory, { files: [] })
  await app.entry.query.refetch()
  expect(app.entry.query.isSuccess).toBe(true)
  expect(app.entry.hasChanges()).toBe(false)
})

test("807 project, branch and server changes cannot borrow a previous workspace's dirty result", async () => {
  const app = await mount()
  app.source.set(app.state.directory, { files: manualChange })
  await untilReviewEntry(() => app.entry.hasChanges())
  app.setState("directory", "F:/review-entry-b")
  expect(app.entry.hasChanges()).toBe(false)
  await untilReviewEntry(() => app.entry.query.isSuccess)
  expect(app.entry.hasChanges()).toBe(false)
  const requests = app.source.requests.length
  app.setState("branch", "other")
  await untilReviewEntry(() => app.source.requests.length > requests && app.entry.query.isSuccess)
  app.setState("scope", "server-b")
  await untilReviewEntry(() => app.source.requests.length > requests + 1 && app.entry.query.isSuccess)
  expect(app.entry.hasChanges()).toBe(false)
})

test("807 existing VCS invalidation discovers external edits and removes a cleaned workspace entry", async () => {
  const app = await mount()
  await untilReviewEntry(() => app.entry.query.isSuccess)
  expect(app.entry.hasChanges()).toBe(false)
  app.source.set(app.state.directory, { files: manualChange })
  await app.queryClient.invalidateQueries({ queryKey: ["session-vcs", app.state.directory] })
  expect(app.entry.hasChanges()).toBe(true)
  app.source.set(app.state.directory, { files: [] })
  await app.queryClient.invalidateQueries({ queryKey: ["session-vcs", app.state.directory] })
  expect(app.entry.hasChanges()).toBe(false)
  expect(app.source.requests).toEqual(["/vcs/status", "/vcs/status", "/vcs/status"])
})
