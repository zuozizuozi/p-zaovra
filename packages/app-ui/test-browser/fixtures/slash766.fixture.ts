import { expect, mock, test } from "bun:test"
import type { CommandView } from "@zaovra-ai/sdk/v2/client"
import type { DirectorySync } from "../../src/context/directory-sync"
import type { FollowupDraft } from "../../src/components/prompt-input/submit"

mock.module("@/utils/toast", () => ({ showToast: () => {} }))
for (const [module, name] of [
  ["@/context/tabs", "useTabs"],
  ["@/context/server-sync", "useServerSync"],
  ["@/context/language", "useLanguage"],
  ["@/context/layout", "useLayout"],
  ["@/context/local", "useLocal"],
  ["@/context/models", "useModels"],
  ["@/context/permission", "usePermission"],
  ["@/context/sdk", "useSDK"],
  ["@/context/sync", "useSync"],
])
  mock.module(module!, () => ({ [name!]: () => {} }))
const submission = await import("../../src/components/prompt-input/submit")
const command: CommandView = { name: "fixture", template: "Inspect $ARGUMENTS", source: "command", hints: [] }
const draft = {
  sessionID: "ses_slash766",
  sessionDirectory: "F:/synthetic766",
  agent: "build",
  model: { providerID: "synthetic766", modelID: "synthetic766" },
  context: [],
  prompt: [{ type: "text" as const, content: "/fixture file.ts", start: 0, end: 16 }],
}
const sync = { data: { command: [command] } } as unknown as DirectorySync
if (process.env.ZAOVRA_SLASH_BENCH === "1") {
  test("766 actual prepareFollowupDraft command lowering CPU", () => {
    const samples = Array.from({ length: 13 }, () => {
      const start = performance.now()
      for (let n = 0; n < 1000; n++) submission.prepareFollowupDraft({ draft, sync })
      return performance.now() - start
    })
    console.log(
      JSON.stringify({
        benchmark: "766 actual prepareFollowupDraft",
        preparesPerSample: 1000,
        samples,
        medianMs: samples.slice(2).toSorted((a, b) => a - b)[5],
        scope: "synchronous ordinary command admission lowering only; excludes RPC, MCP and UI latency",
      }),
    )
  })
} else {
  test("766 ordinary commands preserve existing lowering semantics", () => {
    const prepared = submission.prepareFollowupDraft({ draft, sync })
    expect(prepared.admission?.text).toBe("Inspect file.ts")
    expect(prepared.admission?.invocation).toBe("/fixture file.ts")
  })
  test("766 remotely rendered skill text is literal and preserves model selection", () => {
    const resolvedCommand: CommandView = {
      name: "skill:review766",
      source: "skill",
      template: "Literal $1 $ARGUMENTS",
      hints: [],
    }
    const prepared = submission.prepareFollowupDraft({
      draft: {
        ...draft,
        resolvedCommand,
        prompt: [{ type: "text", content: "/skill:review766 input", start: 0, end: 21 }],
      },
      sync,
    })
    expect(prepared.admission?.text).toBe("Literal $1 $ARGUMENTS")
    expect(prepared.admission?.invocation).toBe("/skill:review766 input")
    expect(prepared.admission?.selection?.model).toEqual({
      id: "synthetic766",
      providerID: "synthetic766",
      variant: undefined,
    })
  })
  test("766 missing reserved slash sources revalidate instead of sending a disabled command as plain text", async () => {
    const calls: unknown[] = []
    const client = {
      v2: {
        command: {
          render: async (input: unknown) => {
            calls.push(input)
            throw new Error("disabled")
          },
        },
      },
    } as unknown as Parameters<typeof submission.resolveSlashCommand>[0]["client"]
    await expect(
      submission.resolveSlashCommand({
        client,
        sync,
        prompt: [{ type: "text", content: "/mcp:removed:review target", start: 0, end: 26 }],
        directory: draft.sessionDirectory,
        agent: draft.agent,
      }),
    ).rejects.toThrow("disabled")
    expect(calls).toEqual([
      {
        name: "mcp:removed:review",
        arguments: "target",
        agent: "build",
        location: { directory: draft.sessionDirectory },
      },
    ])
    expect(
      await submission.resolveSlashCommand({
        client,
        sync,
        prompt: draft.prompt,
        directory: draft.sessionDirectory,
        agent: draft.agent,
      }),
    ).toBeUndefined()
    expect(calls).toHaveLength(1)
  })
  test("766 lost admission acknowledgement retries the same rendered content without another MCP call", async () => {
    let renders = 0
    const prompts: unknown[] = []
    const client = {
      v2: {
        command: { render: async () => ({ data: { data: { template: "MCP literal $1 " + ++renders } } }) },
        session: {
          prompt: async (input: unknown) => {
            prompts.push(input)
            if (prompts.length === 1) throw new Error("lost acknowledgement")
            return { data: { data: {} } }
          },
        },
      },
    } as unknown as Parameters<typeof submission.sendFollowupDraft>[0]["client"]
    const dynamic: FollowupDraft = {
      ...draft,
      prompt: [{ type: "text", content: "/mcp:test:review target", start: 0, end: 23 }],
    }
    const sendSync = {
      ...sync,
      session: {
        optimistic: {
          remove: () => {},
          add: () => {
            throw new Error("admit-only must not add an optimistic message")
          },
        },
      },
    } as unknown as DirectorySync
    const input = {
      client,
      sync: sendSync,
      serverSync: {} as Parameters<typeof submission.sendFollowupDraft>[0]["serverSync"],
      draft: dynamic,
      messageID: "msg766",
      delivery: "queue" as const,
      resume: false,
    }
    await expect(submission.sendFollowupDraft(input)).rejects.toThrow("lost acknowledgement")
    expect(dynamic.admission?.text).toBe("MCP literal $1 1")
    expect(await submission.sendFollowupDraft(input)).toBe(true)
    expect(renders).toBe(1)
    expect(prompts[0]).toEqual(prompts[1])
  })
  test("766 an unresolved skill cannot be silently lowered to an empty admission", () => {
    const catalog = {
      data: { command: [{ name: "skill:review766", source: "skill", template: "", hints: [] }] },
    } as unknown as DirectorySync
    expect(() =>
      submission.prepareFollowupDraft({
        draft: { ...draft, prompt: [{ type: "text", content: "/skill:review766", start: 0, end: 16 }] },
        sync: catalog,
      }),
    ).toThrow("Resolve")
  })
}
