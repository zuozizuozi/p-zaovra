import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { sendFollowupDraft, cancelFollowupDraft, prepareFollowupDraft } from "../src/components/prompt-input/submit"
import { adaptCommand } from "../src/context/global-sync/utils"
import { adaptSessionInput } from "../src/context/v2-session-adapter"
import { extractPromptFromParts } from "../src/utils/prompt"

test("queue admission sends a stable ID and does not project a user turn or change busy state", async () => {
  const requests: {
    id: string
    delivery: string
    resume?: boolean
    prompt: {
      text: string
      invocation?: string
      selection?: { agent: string; model: { id: string; providerID: string } }
      subtask?: { command: string; agent: string; model: { id: string; providerID: string } }
    }
  }[] = []
  const effects: string[] = []
  const paths: string[] = []
  let cancelled = false
  let dropNextPrompt = false
  const agents: { agent: string }[] = []
  const models: { model: { id: string; providerID: string; variant?: string } }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      if (request.method === "POST") paths.push(request.url ?? "")
      if (request.method === "POST" && request.url?.endsWith("/prompt"))
        requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      if (request.method === "POST" && request.url?.endsWith("/prompt") && dropNextPrompt) {
        dropNextPrompt = false
        response.destroy()
        return
      }
      if (request.method === "POST" && request.url?.endsWith("/agent"))
        agents.push(JSON.parse(Buffer.concat(chunks).toString()))
      if (request.method === "POST" && request.url?.endsWith("/model"))
        models.push(JSON.parse(Buffer.concat(chunks).toString()))
      response.setHeader("Content-Type", "application/json")
      response.setHeader("Access-Control-Allow-Origin", "*")
      response.setHeader("Access-Control-Allow-Headers", "*")
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      response.end(JSON.stringify({ data: cancelled ? { cancelledSeq: 1 } : {} }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test server address")
  const input = {
    client: createZaovraClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true }),
    messageID: "msg_retry",
    delivery: "queue",
    optimisticBusy: true,
    draft: {
      sessionID: "ses_queue",
      sessionDirectory: "/repo",
      agent: "build",
      model: { modelID: "test", providerID: "test" },
      context: [],
      prompt: [{ type: "text", content: "Later", start: 0, end: 5 }],
    },
    sync: {
      data: { command: [] },
      session: { optimistic: { add: () => effects.push("add"), remove: () => effects.push("remove") } },
    },
    serverSync: { session: { set: () => effects.push("status") } },
  } as Parameters<typeof sendFollowupDraft>[0]
  try {
    expect(await sendFollowupDraft(input)).toBe(true)
    expect(await sendFollowupDraft(input)).toBe(true)
    expect(
      requests.map((request) => ({ id: request.id, delivery: request.delivery, text: request.prompt.text })),
    ).toEqual([
      { id: "msg_retry", delivery: "queue", text: "Later" },
      { id: "msg_retry", delivery: "queue", text: "Later" },
    ])
    expect(effects).toEqual([])
    const content = "/inspect\nbranch feature"
    input.draft.prompt = [{ type: "text", content, start: 0, end: content.length }]
    input.draft.variant = "previous-model-variant"
    input.sync.data.command = [
      {
        name: "inspect",
        template: "Inspect $ARGUMENTS",
        agent: "plan",
        model: "provider/model/with/slashes",
        hints: [],
      },
    ]
    expect(await sendFollowupDraft({ ...input, messageID: "msg_command" })).toBe(true)
    expect(agents).toEqual([])
    expect(models).toEqual([])
    expect(requests.at(-1)?.prompt.selection).toEqual({
      agent: "plan",
      model: { id: "model/with/slashes", providerID: "provider" },
    })
    expect(requests.at(-1)?.prompt.text).toBe("Inspect branch feature")
    input.sync.data.command[0].subtask = true
    expect(await sendFollowupDraft({ ...input, messageID: "msg_child_command" })).toBe(true)
    expect(requests.at(-1)?.prompt.selection).toEqual({
      agent: "build",
      model: { id: "test", providerID: "test", variant: "previous-model-variant" },
    })
    expect(requests.at(-1)?.prompt.subtask).toEqual({
      command: "inspect",
      agent: "plan",
      model: { id: "model/with/slashes", providerID: "provider" },
    })
    const admitted = requests.at(-1)!
    expect(admitted.prompt.invocation).toBe(content)
    const restored = extractPromptFromParts(
      adaptSessionInput(
        { id: input.draft.sessionID, agent: "build" },
        {
          id: admitted.id,
          sessionID: input.draft.sessionID,
          delivery: "queue",
          admittedSeq: 1,
          timeCreated: 1,
          prompt: admitted.prompt,
        },
      ).parts,
      { directory: input.draft.sessionDirectory },
    )
    expect(restored[0]).toMatchObject({ content })
    expect(
      await sendFollowupDraft({ ...input, messageID: "msg_edited", draft: { ...input.draft, prompt: restored } }),
    ).toBe(true)
    expect(requests.at(-1)?.prompt).toEqual(admitted.prompt)
    input.sync.data.command = [
      adaptCommand({
        name: "inspect",
        template: "Original $ARGUMENTS",
        agent: "plan",
        model: { id: "model/with/slashes", providerID: "provider", variant: "command-variant" },
        subtask: true,
      }),
    ]
    const frozen = prepareFollowupDraft(input)
    dropNextPrompt = true
    await expect(sendFollowupDraft({ ...input, draft: frozen, messageID: "msg_frozen" })).rejects.toThrow()
    const first = requests.at(-1)
    expect(first?.prompt.subtask?.model).toEqual({
      id: "model/with/slashes",
      providerID: "provider",
      variant: "command-variant",
    })
    input.sync.data.command[0].template = "Changed $ARGUMENTS"
    input.sync.data.command[0].agent = "build"
    input.sync.data.command[0].model = "other/model"
    expect(await sendFollowupDraft({ ...input, draft: frozen, messageID: "msg_frozen" })).toBe(true)
    expect(requests.at(-1)).toEqual(first)
    paths.length = 0
    await cancelFollowupDraft({ ...input, messageID: "msg_conversion", cancelID: "msg_original" })
    expect(paths).toEqual([
      "/api/session/ses_queue/input/msg_original/cancel",
      "/api/session/ses_queue/prompt",
      "/api/session/ses_queue/input/msg_conversion/cancel",
    ])
    expect(requests.at(-1)).toMatchObject({ id: "msg_conversion", delivery: "steer", resume: false })
    cancelled = true
    await expect(sendFollowupDraft(input)).rejects.toThrow("already been cancelled")
    await cancelFollowupDraft({ ...input, messageID: "msg_conversion", cancelID: "msg_original" })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
