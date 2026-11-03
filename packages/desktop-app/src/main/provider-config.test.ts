import { expect, test } from "bun:test"
import {
  providerBaseURL,
  providerBaseURLCorrection,
  providerModelType,
  discoverProviderModels,
  detectProviderProtocol,
} from "@zaovra-ai/app/provider-discovery"
import { validateCustomProvider } from "../../../app-ui/src/components/dialog-custom-provider-form"

for (const endpoint of [
  "chat/completions",
  "responses",
  "messages",
  "models",
  "audio/transcriptions",
  "audio/translations",
  "audio/speech",
  "embeddings",
  "images/generations",
  "images/edits",
  "completions",
  "audio/transcriptions/chat/completions",
  "responses/chat/completions",
])
  test(`trims ${endpoint} to the base and never duplicates endpoint paths`, () => {
    const value = `https://api.ant-ling.com/proxy/v1/${endpoint}/`
    expect(providerBaseURL(value)).toBe("https://api.ant-ling.com/proxy/v1")
    expect(providerBaseURLCorrection(value)).toBe("https://api.ant-ling.com/proxy/v1")
    expect(providerBaseURL(providerBaseURL(value))).toBe(providerBaseURL(value))
  })

test("normalizes a bare Ant Ling address and keeps clean/custom bases and URL guards", () => {
  expect(providerBaseURL("api.ant-ling.com/v1/audio/transcriptions")).toBe("https://api.ant-ling.com/v1")
  expect(providerBaseURL("https://proxy.test/custom/v2")).toBe("https://proxy.test/custom/v2")
  expect(providerBaseURLCorrection("https://api.ant-ling.com/v1")).toBeUndefined()
  expect(providerBaseURLCorrection("https://user:secret@proxy.test/v1/responses")).toBeUndefined()
  expect(providerBaseURLCorrection("https://proxy.test/v1/responses?key=secret")).toBeUndefined()
})

for (const [id, type] of [
  ["Ming-3.0-asr-tiny", "asr"],
  ["whisper-large-v3", "asr"],
  ["gpt-4o-transcribe", "asr"],
  ["audio-transcription", "asr"],
  ["Ming-3.0-tts-tiny", "tts"],
  ["text-to-speech-1", "tts"],
  ["speech-1", "tts"],
  ["text-embedding-3-small", "embedding"],
  ["bge-reranker-v2-m3", "embedding"],
  ["vendor/embed-v1", "embedding"],
  ["image-generation", "image"],
  ["dall-e-3", "image"],
  ["sd-xl", "image"],
] as const)
  test(`recognizes ${id} as ${type} rather than a chat model`, () => {
    expect(providerModelType({ id })).toBe(type)
  })

test("uses task metadata and display names without excluding multimodal chat input capabilities", () => {
  expect(providerModelType({ id: "alias", name: "Whisper large" })).toBe("asr")
  expect(providerModelType({ id: "alias" }, { task: "embedding" })).toBe("embedding")
  expect(providerModelType({ id: "alias" }, { metadata: { pipeline_tag: "image-generation" } })).toBe("image")
  expect(providerModelType({ id: "alias" }, { capabilities: ["rerank"] })).toBe("embedding")
  for (const id of ["Ling-2.5-1T", "Ling-flash-2.0", "gpt-4o", "Qwen3-Omni", "sdchat", "Vendor/Assistant"]) {
    expect(
      providerModelType(
        { id },
        { modalities: { input: ["image", "audio"] }, description: "Understands speech and images" },
      ),
    ).toBeUndefined()
  }
  expect(providerModelType({ id: "alias" }, { capabilities: { chat: true }, task: "speech" })).toBeUndefined()
})

test("Ant Ling discovery fixes the URL and keeps all models with non-chat type labels", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.includes("/api/pricing")) return new Response(null, { status: 404 })
      calls.push(new URL(request.url).pathname)
      return Response.json({
        data: [
          { id: "Ming-3.0-asr-tiny" },
          { id: "tts-v1" },
          { id: "alias", type: "embedding" },
          { id: "picture", metadata: { task: "image-generation" } },
          { id: "Ling-2.5-1T" },
          { id: "Ling-flash-2.0", modalities: { input: ["image"] } },
        ],
      })
    },
  })
  try {
    expect(await discoverProviderModels({ baseURL: `${server.url}v1/audio/transcriptions`, apiKey: "" })).toEqual([
      { id: "Ming-3.0-asr-tiny", name: "Ming-3.0-asr-tiny", type: "asr" },
      { id: "tts-v1", name: "tts-v1", type: "tts" },
      { id: "alias", name: "alias", type: "embedding" },
      { id: "picture", name: "picture", type: "image" },
      { id: "Ling-2.5-1T", name: "Ling-2.5-1T" },
      { id: "Ling-flash-2.0", name: "Ling-flash-2.0" },
    ])
    expect(calls).toEqual(["/v1/models"])
  } finally {
    server.stop(true)
  }
})

test("an ASR-only catalog remains visible with its type", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ data: [{ id: "Ming-3.0-asr-tiny" }] })
    },
  })
  try {
    expect(await discoverProviderModels({ baseURL: server.url.href, apiKey: "" })).toEqual([
      { id: "Ming-3.0-asr-tiny", name: "Ming-3.0-asr-tiny", type: "asr" },
    ])
  } finally {
    server.stop(true)
  }
})

test("ASR and Ling configurations can both be retained with the corrected base", () => {
  const input = {
    form: {
      providerID: "ant-ling",
      name: "Ant Ling",
      baseURL: "https://api.ant-ling.com/v1/audio/transcriptions",
      apiKey: "",
      models: [{ row: "0", id: "Ming-3.0-asr-tiny", name: "", err: {} }],
      headers: [],
      err: {},
    },
    t: (key: string, vars?: Record<string, string | number | boolean>) => key + (vars?.type ? ":" + vars.type : ""),
    disabledProviders: [],
    existingProviderIDs: new Set<string>(),
  }
  const result = validateCustomProvider(input)
  expect(result.result?.config.options.baseURL).toBe("https://api.ant-ling.com/v1")
  expect(result.models[0]!.id).toBeUndefined()
  expect(result.err.baseURL).toBeUndefined()
  expect(
    validateCustomProvider({
      ...input,
      form: { ...input.form, models: [{ ...input.form.models[0]!, id: "Ling-2.5-1T" }] },
    }).result?.config.options.baseURL,
  ).toBe("https://api.ant-ling.com/v1")
})

test("protocol detection rejects ASR without a request and probes Ling only at normalized endpoints", async () => {
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.includes("/api/pricing")) return new Response(null, { status: 404 })
      const path = new URL(request.url).pathname
      calls.push(path)
      expect((await request.json()).model).toBe("Ling-2.5-1T")
      return path.endsWith("/responses") ? new Response(null, { status: 404 }) : Response.json({ choices: [] })
    },
  })

  try {
    const baseURL = `${server.url}v1/audio/transcriptions`
    await expect(detectProviderProtocol({ baseURL, apiKey: "", modelID: "Ming-3.0-asr-tiny" })).rejects.toThrow(
      "nonChatModel:asr",
    )
    expect(calls).toEqual([])
    expect(await detectProviderProtocol({ baseURL, apiKey: "", modelID: "Ling-2.5-1T" })).toBe("openai")
    expect(calls).toEqual(["/v1/responses", "/v1/chat/completions"])
  } finally {
    server.stop(true)
  }
})

for (const status of [400, 404])
  test(`HTTP ${status} on a corrected endpoint provides an actionable URL diagnostic`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, { status })
      },
    })
    try {
      await expect(
        detectProviderProtocol({ baseURL: `${server.url}v1/audio/transcriptions`, apiKey: "", modelID: "Ling-2.5-1T" }),
      ).rejects.toThrow(`endpointURL:${server.url}v1`)
    } finally {
      server.stop(true)
    }
  })

for (const protocol of ["responses", "openai"] as const)
  for (const failure of ["echo", "wrong-role", "wrong-format"] as const)
    test(`${protocol} rejects ${failure} without accepting an invalid chat response`, async () => {
      const calls: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname.includes("/api/pricing")) return new Response(null, { status: 404 })
          const path = new URL(request.url).pathname
          calls.push(path)
          if (protocol === "openai" && path.endsWith("/responses")) return new Response(null, { status: 404 })
          if (failure === "wrong-format") return Response.json({ text: "Reply OK" })
          const role = failure === "wrong-role" ? "user" : "assistant"
          return Response.json(
            protocol === "responses"
              ? { output: [{ type: "message", role, content: [{ type: "output_text", text: "Reply OK" }] }] }
              : { choices: [{ message: { role, content: "Reply OK" } }] },
          )
        },
      })
      try {
        await expect(
          detectProviderProtocol({ baseURL: server.url.href, apiKey: "", modelID: "unknown-model" }),
        ).rejects.toThrow(failure === "echo" ? "echoedModelReply" : "invalidModelReply")
        expect(calls.length).toBe(protocol === "responses" ? 1 : 2)
      } finally {
        server.stop(true)
      }
    })

test("a real chat response to the probe is accepted for an unknown model", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      })
    },
  })
  try {
    expect(await detectProviderProtocol({ baseURL: server.url.href, apiKey: "", modelID: "unknown-model" })).toBe(
      "responses",
    )
  } finally {
    server.stop(true)
  }
})
