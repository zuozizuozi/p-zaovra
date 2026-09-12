import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptInputV2Attachments } from "../../session-ui/src/v2/components/prompt-input/attachments"
import type { PromptInputV2Prompt } from "../../session-ui/src/v2/components/prompt-input/types"

function fixture(prepare: (file: File, signal?: AbortSignal) => Promise<File[]>) {
  return createRoot((dispose) => {
    let identity = "first"
    let prompt: PromptInputV2Prompt = []
    const editor = document.createElement("div")
    const attachments = createPromptInputV2Attachments({
      prepare,
      identity: () => identity,
      capture: () => ({
        current: () => prompt,
        cursor: () => 0,
        set: (value) => {
          prompt = value
        },
      }),
      editor: () => editor,
      focusEditor: () => {},
      addPart: () => false,
      setDraggingType: () => {},
      directory: () => "",
      isDialogActive: () => false,
      warn: () => {},
      onError: (error) => {
        throw error
      },
    })
    return {
      attachments,
      dispose,
      prompt: () => prompt,
      switchSession: () => {
        identity = "second"
      },
    }
  })
}
const doc = () => new File(["source"], "sample.docx")
const converted = () => new File(["invoice 420"], "sample.docx.md", { type: "text/plain" })

test("pending attachment remains busy until converted content is attached", async () => {
  const ready = Promise.withResolvers<File[]>()
  const f = fixture(() => ready.promise)
  try {
    const pending = f.attachments.addAttachments([doc()])
    await Promise.resolve()
    expect(f.attachments.busy()).toBe(true)
    expect(f.prompt()).toHaveLength(0)
    ready.resolve([converted()])
    expect(await pending).toBe(true)
    expect(f.attachments.busy()).toBe(false)
    expect(f.prompt()[0]).toMatchObject({ type: "image", mime: "text/plain", filename: "sample.docx.md" })
  } finally {
    f.dispose()
  }
})

test("removal aborts work and ignores late results", async () => {
  const ready = Promise.withResolvers<File[]>()
  let signal: AbortSignal | undefined
  const f = fixture((_file, value) => {
    signal = value
    return ready.promise
  })
  try {
    const pending = f.attachments.addAttachments([doc()])
    await Promise.resolve()
    f.attachments.dismiss(f.attachments.jobs()[0]!.id)
    expect(signal?.aborted).toBe(true)
    ready.resolve([converted()])
    await pending
    expect(f.prompt()).toHaveLength(0)
    expect(f.attachments.busy()).toBe(false)
  } finally {
    f.dispose()
  }
})

test("session switch prevents remaining batch reaching the new draft", async () => {
  const ready = Promise.withResolvers<File[]>()
  let calls = 0
  const f = fixture(() => {
    calls++
    return ready.promise
  })
  try {
    const pending = f.attachments.addAttachments([doc(), doc()])
    await Promise.resolve()
    f.switchSession()
    ready.resolve([converted()])
    await pending
    expect(calls).toBe(1)
    expect(f.prompt()).toHaveLength(0)
    expect(f.attachments.jobs()[0]?.state).toBe("error")
  } finally {
    f.dispose()
  }
})

test("failed conversion stays visible and retries without duplicate content", async () => {
  let calls = 0
  const f = fixture(async () => {
    if (++calls === 1) throw new Error("broken file")
    return [converted()]
  })
  try {
    await f.attachments.addAttachments([doc()])
    expect(f.attachments.jobs()[0]?.error).toBe("broken file")
    expect(f.attachments.busy()).toBe(true)
    f.attachments.jobs()[0]!.retry()
    for (let count = 0; count < 50 && f.attachments.busy(); count++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.attachments.busy()).toBe(false)
    expect(f.prompt()).toHaveLength(1)
  } finally {
    f.dispose()
  }
})
