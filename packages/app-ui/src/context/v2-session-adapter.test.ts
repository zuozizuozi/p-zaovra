import { describe, expect, test } from "bun:test"
import type { SessionInputAdmitted, SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { adaptSessionInput, adaptSessionMessages, hasUnfinishedShell } from "./v2-session-adapter"

const session: SessionV2Info = {
  id: "ses_test",
  projectID: "project",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "test",
  location: { directory: "/repo" },
}

describe("V2 session timeline adapter", () => {
  test("only reports shell history without a completion record, including after reload", () => {
    const pending: SessionMessage = {
      id: "shell_pending",
      type: "shell",
      callID: "call_pending",
      command: "build",
      output: "building",
      time: { created: 1 },
    }
    const running = adaptSessionMessages(session, [pending])
    expect(
      hasUnfinishedShell(
        running.map((item) => item.message),
        Object.fromEntries(running.map((item) => [item.message.id, item.parts])),
      ),
    ).toBe(true)
    const completed = adaptSessionMessages(session, [{ ...pending, time: { created: 1, completed: 2 } }])
    expect(
      hasUnfinishedShell(
        completed.map((item) => item.message),
        Object.fromEntries(completed.map((item) => [item.message.id, item.parts])),
      ),
    ).toBe(false)
    expect(hasUnfinishedShell([], {})).toBe(false)
  })
  test("isolates reasoning and tool IDs across messages without changing tool call IDs", () => {
    const messages: SessionMessage[] = [
      { id: "msg_user", type: "user", text: "run", time: { created: 1 } },
      ...["msg_first", "msg_second"].map(
        (id, index): SessionMessage => ({
          id,
          type: "assistant",
          agent: "build",
          model: session.model!,
          time: { created: index + 2 },
          content: [
            { id: "reasoning-0", type: "reasoning", text: id },
            {
              id: "call-0",
              type: "tool",
              name: "read",
              time: { created: index + 2 },
              state: { status: "pending", input: "" },
            },
          ],
        }),
      ),
    ]
    const parts = adaptSessionMessages(session, messages)
      .slice(1)
      .flatMap((message) => message.parts)
    expect(new Set(parts.map((part) => part.id)).size).toBe(4)
    expect(parts.filter((part) => part.type === "tool").map((part) => part.callID)).toEqual(["call-0", "call-0"])
  })
  test("maps diagnostics through the actual target without confusing same-named files", () => {
    const issue = [
      {
        severity: 1,
        message: "Current file error",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ]
    for (const name of ["write", "edit"]) {
      const result = adaptSessionMessages(session, [
        { id: "user", type: "user", text: "Edit file", time: { created: 1 } },
        {
          id: "assistant",
          type: "assistant",
          agent: "build",
          model: session.model!,
          time: { created: 2 },
          content: [
            {
              id: "tool",
              type: "tool",
              name,
              time: { created: 2 },
              state: {
                status: "completed",
                input: { path: "src/a.ts" },
                content: [],
                structured: {
                  target: "/repo/src/a.ts",
                  lsp: {
                    diagnostics: {
                      "/repo/src/a.ts": issue,
                      "/other/src/a.ts": [{ ...issue[0], message: "Other error" }],
                    },
                    failed: [],
                  },
                },
              },
            },
          ],
        },
      ])
      expect(result[1].parts[0]).toMatchObject({
        state: { input: { filePath: "src/a.ts" }, metadata: { diagnostics: { "src/a.ts": issue } } },
      })
    }
  })
  test("maps V2 patch files into added, modified and deleted cards", () => {
    const diagnostic = { severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
    const result = adaptSessionMessages(session, [
      { id: "user", type: "user", text: "patch", time: { created: 1 } },
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: session.model!,
        time: { created: 2 },
        content: [
          {
            id: "patch",
            type: "tool",
            name: "apply_patch",
            time: { created: 2 },
            state: {
              status: "completed",
              input: {},
              content: [],
              structured: {
                applied: [
                  {
                    resource: "new.ts",
                    target: "/repo/new.ts",
                    lsp: { diagnostics: { "/repo/new.ts": [{ ...diagnostic, message: "New error" }] }, failed: [] },
                  },
                  {
                    resource: "edit.ts",
                    target: "/repo/edit.ts",
                    lsp: {
                      diagnostics: {
                        "/repo/new.ts": [{ ...diagnostic, message: "Unrelated snapshot" }],
                        "/repo/edit.ts": [{ ...diagnostic, message: "Edit error" }],
                      },
                      failed: [],
                    },
                  },
                  {
                    resource: "old.ts",
                    target: "/repo/old.ts",
                    lsp: { diagnostics: { "/repo/old.ts": [] }, failed: [] },
                  },
                ],
                files: [
                  { file: "new.ts", status: "added", patch: "+new" },
                  { file: "edit.ts", status: "modified", patch: "-old\n+new" },
                  { file: "old.ts", status: "deleted", patch: "-old" },
                ],
              },
            },
          },
        ],
      },
    ])
    expect(result[1].parts[0]).toMatchObject({
      state: {
        metadata: {
          diagnostics: {
            "new.ts": [{ ...diagnostic, message: "New error" }],
            "edit.ts": [{ ...diagnostic, message: "Edit error" }],
            "old.ts": [],
          },
          files: [
            { filePath: "new.ts", relativePath: "new.ts", type: "add", patch: "+new" },
            { filePath: "edit.ts", type: "update", patch: "-old\n+new" },
            { filePath: "old.ts", type: "delete", patch: "-old" },
          ],
        },
      },
    })
  })

  test("maps file tool paths and final formatted write content to their cards", () => {
    const patch = { file: "sample.ts", patch: "@@ -1 +1 @@\n-before\n+after", additions: 1, deletions: 1 }
    const result = adaptSessionMessages(session, [
      { id: "user", type: "user", text: "update", time: { created: 1 } },
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: session.model!,
        time: { created: 2 },
        content: [
          {
            id: "write",
            type: "tool",
            name: "write",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { path: "sample.ts", content: "unformatted" },
              content: [],
              structured: { content: "formatted", formatting: { ran: ["prettier"], failed: [] } },
            },
          },
          {
            id: "edit",
            type: "tool",
            name: "edit",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { path: "sample.ts", oldString: "before", newString: "after" },
              content: [],
              structured: { files: [patch] },
            },
          },
          {
            id: "read",
            type: "tool",
            name: "read",
            time: { created: 2 },
            state: {
              status: "running",
              input: { path: "sample.ts" },
              content: [],
              structured: {},
            },
          },
        ],
      },
    ])
    expect(result[1].parts[0]).toMatchObject({ state: { input: { filePath: "sample.ts", content: "formatted" } } })
    expect(result[1].parts[1]).toMatchObject({
      state: { input: { filePath: "sample.ts" }, metadata: { filediff: patch } },
    })
    expect(result[1].parts[2]).toMatchObject({ state: { input: { filePath: "sample.ts" } } })
  })

  test("exposes the child session returned by the V2 task tool to its card", () => {
    const result = adaptSessionMessages(session, [
      { id: "msg_user", type: "user", text: "delegate", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        time: { created: 2 },
        content: [
          {
            id: "call_task",
            type: "tool",
            name: "task",
            time: { created: 2, completed: 3 },
            state: {
              status: "completed",
              input: { subagent_type: "explore" },
              content: [{ type: "text", text: "Done" }],
              structured: { task_id: "ses_actual_child", content: "Done" },
            },
          },
        ],
      },
    ])
    expect(result[1].parts[0]).toMatchObject({
      state: { metadata: { sessionId: "ses_actual_child", task_id: "ses_actual_child" } },
    })
  })

  test("maps a durable pending input into a visible user message", () => {
    const input: SessionInputAdmitted = {
      admittedSeq: 3,
      id: "msg_pending",
      sessionID: session.id,
      prompt: { text: "also update the tests" },
      delivery: "steer",
      timeCreated: 4,
    }

    expect(adaptSessionInput(session, input)).toMatchObject({
      message: { id: "msg_pending", role: "user", time: { created: 4 } },
      parts: [{ id: "msg_pending:text", type: "text", text: "also update the tests" }],
    })
  })

  test("keeps user attachments and assigns assistants to the consumed user turn", () => {
    const messages: SessionMessage[] = [
      {
        id: "msg_user",
        type: "user",
        text: "inspect this",
        files: [{ uri: "file:///repo/a.ts", mime: "text/typescript", name: "a.ts" }],
        agents: [{ name: "reviewer", source: { text: "@reviewer", start: 0, end: 9 } }],
        time: { created: 1 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ id: "text_1", type: "text", text: "done" }],
        time: { created: 2, completed: 3 },
      },
    ]

    const result = adaptSessionMessages(session, messages)

    expect(result.map((item) => item.message.id)).toEqual(["msg_user", "msg_assistant"])
    expect(result[1].message).toMatchObject({ role: "assistant", parentID: "msg_user" })
    expect(result[0].parts.map((part) => part.type)).toEqual(["text", "file", "agent"])
    expect(result[1].parts).toEqual([
      { id: "msg_assistant:text_1", sessionID: "ses_test", messageID: "msg_assistant", type: "text", text: "done" },
    ])
  })

  test("does not attach an assistant to a newer unrelated user when a page lacks its parent", () => {
    const messages: SessionMessage[] = [
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ id: "text_1", type: "text", text: "older answer" }],
        time: { created: 1 },
      },
      { id: "msg_new_user", type: "user", text: "new request", time: { created: 2 } },
    ]

    expect(adaptSessionMessages(session, messages).map((item) => item.message.id)).toEqual(["msg_new_user"])
  })

  test("maps tool completion into the existing desktop tool part contract", () => {
    const messages: SessionMessage[] = [
      { id: "msg_user", type: "user", text: "run", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            id: "call_1",
            type: "tool",
            name: "shell",
            time: { created: 2, ran: 2, completed: 3 },
            state: {
              status: "completed",
              input: { command: "pwd" },
              structured: {},
              content: [{ type: "text", text: "/repo" }],
            },
          },
        ],
        time: { created: 2, completed: 3 },
      },
    ]

    expect(adaptSessionMessages(session, messages)[1].parts[0]).toMatchObject({
      type: "tool",
      tool: "shell",
      state: { status: "completed", output: "/repo" },
    })
  })
})
