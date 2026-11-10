import { expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@zaovra-ai/ui/context/dialog"
import { dict } from "@/i18n/en"

mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, vars?: Record<string, string | number>) => {
      const value = dict[key] ?? key
      return Object.entries(vars ?? {}).reduce(
        (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
        value,
      )
    },
  }),
}))
const reads: { sessionID: string; messageID: string }[] = []
const serverPlan = { files: ["git-command.txt"], coverage: "snapshot" as const, token: "exact-server-token" }
mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({
    client: {
      v2: {
        session: {
          revert: {
            plan: async (input: { sessionID: string; messageID: string }) => {
              reads.push(input)
              return { data: { data: serverPlan } }
            },
          },
        },
      },
    },
  }),
}))

const { DialogRevertSession, useRevertConfirmation } = await import("@/components/dialog-revert-session")

test.each([{ files: [] as string[] }, { files: ["report.html", "图片.png"] }])(
  "789 real confirmation lists only the server plan and cancels without confirming %j",
  async ({ files }) => {
    const counts = { loads: 0, confirms: 0, cancels: 0 }
    const host = document.createElement("main")
    document.body.append(host)
    const dispose = render(
      () => (
        <DialogProvider>
          <Open />
        </DialogProvider>
      ),
      host,
    )
    function Open() {
      const dialog = useDialog()
      return (
        <button
          onClick={() =>
            dialog.show(() => (
              <DialogRevertSession
                load={async () => {
                  counts.loads++
                  return { files, coverage: "file-tools", token: "server-token" }
                }}
                onCancel={() => counts.cancels++}
                onConfirm={() => counts.confirms++}
              />
            ))
          }
        >
          Open fixture
        </button>
      )
    }
    host.querySelector<HTMLButtonElement>("button")!.click()
    await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-content"] button')).some(
        (button) => button.textContent === dict["session.revert.confirm"] && !button.disabled,
      ),
    )
    const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!
    expect(content).not.toBeNull()
    expect(counts.loads).toBe(1)
    expect(content.textContent).toContain(dict["session.revert.permanentWarning"])
    expect(content.textContent).toContain(dict["session.revert.fileToolsOnly"])
    expect(Array.from(content.querySelectorAll("li"), (item) => item.textContent)).toEqual(files)
    if (!files.length) expect(content.textContent).toContain(dict["session.revert.noFiles"])
    Array.from(content.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Cancel")!
      .click()
    expect(counts.confirms).toBe(0)
    await waitFor(() => !document.querySelector('[data-slot="dialog-content"]'))
    expect(counts.cancels).toBe(1)
    dispose()
    host.remove()
  },
)

test("789 loading or failed read-only plans cannot be confirmed", async () => {
  const state = { confirms: 0 }
  const host = document.createElement("main")
  document.body.append(host)
  const [loading, setLoading] = createStore<{ reject?: (error: Error) => void }>({})
  const dispose = render(
    () => (
      <DialogProvider>
        <Open />
      </DialogProvider>
    ),
    host,
  )
  function Open() {
    const dialog = useDialog()
    return (
      <button
        onClick={() =>
          dialog.show(() => (
            <DialogRevertSession
              load={() => new Promise((_, reject) => setLoading("reject", () => reject))}
              onCancel={() => {}}
              onConfirm={() => state.confirms++}
            />
          ))
        }
      >
        Open fixture
      </button>
    )
  }
  host.querySelector<HTMLButtonElement>("button")!.click()
  await waitFor(() => !!document.querySelector('[data-slot="dialog-content"]'))
  const confirm = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-content"] button')).find(
      (button) => button.textContent === dict["session.revert.confirm"],
    )!
  expect(confirm().disabled).toBe(true)
  loading.reject!(new Error("fixture unavailable"))
  await waitFor(() => !!document.querySelector('[role="alert"]'))
  expect(confirm().disabled).toBe(true)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(dict["session.revert.planFailed"])
  confirm().click()
  expect(state.confirms).toBe(0)
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-content"] button'))
    .find((button) => button.textContent === "Cancel")!
    .click()
  await waitFor(() => !document.querySelector('[data-slot="dialog-content"]'))
  dispose()
  host.remove()
})

test.each([{ confirm: true }, { confirm: false }])(
  "789 snapshot hook preserves the server token and supports dismissal %j",
  async ({ confirm }) => {
    const pending = { result: Promise.resolve<Pick<typeof serverPlan, "token"> | undefined>(undefined) }
    const host = document.createElement("main")
    document.body.append(host)
    const before = reads.length
    const dispose = render(
      () => (
        <DialogProvider>
          <Open />
        </DialogProvider>
      ),
      host,
    )
    function Open() {
      const ask = useRevertConfirmation()
      return (
        <button
          onClick={() => {
            pending.result = ask({ sessionID: "ses_fixture", messageID: "msg_fixture" })
          }}
        >
          Open hook
        </button>
      )
    }
    host.querySelector<HTMLButtonElement>("button")!.click()
    await waitFor(() =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-content"] button')).some(
        (button) => button.textContent === dict["session.revert.confirm"] && !button.disabled,
      ),
    )
    const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!
    expect(content.textContent).toContain(dict["session.revert.listedOnly"])
    expect(content.textContent).not.toContain(dict["session.revert.fileToolsOnly"])
    expect(Array.from(content.querySelectorAll("li"), (item) => item.textContent)).toEqual(serverPlan.files)
    const label = confirm ? dict["session.revert.confirm"] : "Cancel"
    Array.from(content.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === label)!
      .click()
    expect((await pending.result)?.token).toBe(confirm ? serverPlan.token : undefined)
    expect(reads.slice(before)).toEqual([{ sessionID: "ses_fixture", messageID: "msg_fixture" }])
    await waitFor(() => !document.querySelector('[data-slot="dialog-content"]'))
    dispose()
    host.remove()
  },
)

async function waitFor(ready: () => boolean) {
  if (ready()) return
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!ready()) return
      observer.disconnect()
      clearTimeout(timeout)
      resolve()
    })
    const timeout = setTimeout(() => {
      observer.disconnect()
      reject(
        new Error(
          "Confirmation fixture did not reach its expected state; read calls=" +
            reads.length +
            "; DOM=" +
            document.body.textContent?.slice(0, 800),
        ),
      )
    }, 2_000)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })
}
