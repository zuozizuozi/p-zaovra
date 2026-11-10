import { afterAll, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { adaptSessionMessages } from "../../src/context/v2-session-adapter"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import type { CommandOption } from "../../src/context/command"

const state = {
  messages: [] as ReturnType<typeof adaptSessionMessages>,
  revert: undefined as { messageID: string } | undefined,
  plans: [] as { sessionID: string; messageID: string }[],
  stages: [] as unknown[],
  prompts: [] as unknown[],
  commands: () => [] as CommandOption[],
  failure: undefined as Error | undefined,
  toasts: [] as { description: string }[],
}
const data = {
  message: { ses_799: [] as ReturnType<typeof adaptSessionMessages>[number]["message"][] },
  part: {} as Record<string, ReturnType<typeof adaptSessionMessages>[number]["parts"]>,
  session_working: () => false,
}
const history = (messages: SessionMessage[]) => {
  state.messages = adaptSessionMessages(session, messages)
  data.message.ses_799 = state.messages.map((item) => item.message)
  data.part = Object.fromEntries(state.messages.map((item) => [item.message.id, item.parts]))
}
const session = { id: "ses_799", agent: "build" } as SessionV2Info
const human = (id: string, created: number, text = "Change two files"): SessionMessage => ({
  id,
  type: "user",
  text,
  time: { created },
})
const shell: SessionMessage = {
  id: "msg_bash_30",
  type: "shell",
  command: "echo done",
  output: "done",
  callID: "msg_bash_30",
  origin: "tool",
  time: { created: 30 },
}
mock.module("@/context/command", () => ({
  useCommand: () => ({
    register: (_: string, commands: typeof state.commands) => {
      state.commands = commands
    },
  }),
}))
mock.module("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/fixture/session/ses_799" }),
  useNavigate: () => () => {},
}))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({}) }))
mock.module("@/components/dialog-revert-session", () => ({
  useRevertConfirmation: () => async (input: { sessionID: string; messageID: string }) => {
    state.plans.push(input)
    return { token: "server-token" }
  },
}))
mock.module("@/context/file", () => ({ useFile: () => ({}), selectionFromLines: () => undefined }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/local", () => ({ useLocal: () => ({}) }))
mock.module("@/context/layout", () => ({ useLayout: () => ({}) }))
mock.module("@/context/permission", () => ({ usePermission: () => ({ isAutoAccepting: () => false }) }))
mock.module("@/context/terminal", () => ({ useTerminal: () => ({}) }))
mock.module("@/utils/toast", () => ({
  showToast: (value: { description: string }) => state.toasts.push(value),
}))
mock.module("@/context/settings", () => ({
  useSettings: () => ({ visibility: { fileTree: () => false }, general: { newLayoutDesigns: () => true } }),
}))
mock.module("@/context/prompt", () => ({
  usePrompt: () => ({ capture: () => ({ set: (value: unknown) => state.prompts.push(value), reset: () => {} }) }),
}))
mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({
    directory: "/fixture",
    client: {
      v2: {
        session: {
          revert: {
            stage: async (input: unknown) => {
              if (state.failure) throw state.failure
              state.stages.push(input)
            },
            clear: async () => {},
          },
        },
      },
    },
  }),
}))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    session: { get: () => ({ revert: state.revert }) },
    data,
  }),
}))
mock.module("@/pages/session/helpers", () => ({
  createSessionTabs: () => ({ activeFileTab: () => undefined, closableTab: () => undefined }),
}))
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: session.id, dir: "fixture" },
    sessionKey: () => session.id,
    tabs: () => ({}),
    view: () => ({}),
  }),
}))
const { useSessionCommands } = await import("../../src/pages/session/use-session-commands")
const dispose = createRoot((dispose) => {
  useSessionCommands({ navigateMessageByOffset: () => {}, setActiveMessage: () => {} })
  return dispose
})
const undo = () => state.commands().find((item) => item.id === "session.undo")!

test("799 actual /undo skips projected Bash and synthetic continuations and uses the message-button human boundary", async () => {
  history([
    human("msg_10", 10),
    human("msg_20", 20),
    shell,
    { id: "msg_40", type: "synthetic", text: "Continue internally", time: { created: 40 } },
  ])
  state.revert = undefined
  await undo().onSelect?.("slash")
  expect(state.plans.at(-1)).toEqual({ sessionID: session.id, messageID: "msg_20" })
  expect(state.stages.at(-1)).toEqual({ sessionID: session.id, messageID: "msg_20", planToken: "server-token" })
  state.revert = { messageID: "msg_20" }
  await undo().onSelect?.("slash")
  expect(state.plans.at(-1)?.messageID).toBe("msg_10")
  history([shell])
  state.revert = undefined
  expect(undo().disabled).toBe(true)
})

test("799 file-only humans remain undo targets", async () => {
  history([
    {
      ...human("msg_file", 20, ""),
      files: [{ uri: "data:text/plain;base64,QQ==", mime: "text/plain", name: "a.txt" }],
    },
    shell,
  ])
  state.revert = undefined
  await undo().onSelect?.("slash")
  expect(state.plans.at(-1)?.messageID).toBe("msg_file")
})

test("799 conflicting /undo shows the server explanation and keeps the draft", async () => {
  history([human("msg_20", 20)])
  state.revert = undefined
  state.failure = new Error("UnexpectedStatus", {
    cause: {
      body: {
        _tag: "UnknownError",
        message: "Cannot restore a.txt: the file changed. Keep or back up your changes before trying again.",
      },
    },
  })
  const before = state.prompts.length
  await undo().onSelect?.("slash")
  expect(state.prompts).toHaveLength(before)
  expect(state.toasts.at(-1)?.description).toContain("Keep or back up your changes")
  state.failure = undefined
})

test("799 production command construction baseline over long projected history", () => {
  history(
    Array.from({ length: 192 }, (_, index) =>
      index % 3 === 2 ? { ...shell, id: "msg_bash_" + index, time: { created: index } } : human("msg_" + index, index),
    ),
  )
  state.revert = undefined
  for (let index = 0; index < 100; index++) state.commands()
  const samples = Array.from({ length: 21 }, () => {
    const start = performance.now()
    for (let index = 0; index < 40; index++) state.commands()
    return performance.now() - start
  })
  console.log(
    JSON.stringify({
      history: 192,
      constructions: 40,
      warmup: 100,
      samples,
      medianMs: [...samples].sort((a, b) => a - b)[10],
    }),
  )
  expect(undo()).toBeDefined()
})
afterAll(dispose)
