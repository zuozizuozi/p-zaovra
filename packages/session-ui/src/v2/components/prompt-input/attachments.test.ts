import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptInputV2Attachments } from "./attachments"
import type { PromptInputV2Prompt } from "./types"

test("612 V2 picker preserves every selected filename and count without a project default", async () => {
  let prompt: PromptInputV2Prompt = []
  const complete = Promise.withResolvers<void>()
  const options: unknown[] = []
  const errors: unknown[] = []
  const selected = ["synthetic.docx", "notes.txt", "two.png"].map((name) => new File(["synthetic content"], name))
  const ctx = createRoot((dispose) => ({
    dispose,
    attachments: createPromptInputV2Attachments({
      capture: () => ({
        current: () => prompt,
        cursor: () => 0,
        set: (value) => {
          prompt = value
        },
      }),
      editor: () => document.createElement("div"),
      focusEditor: () => undefined,
      addPart: () => false,
      setDraggingType: () => undefined,
      directory: () => "C:\\Users\\fixture\\Documents\\Default Project",
      identity: () => "synthetic-profile",
      isDialogActive: () => false,
      warn: () => errors.push("unsupported"),
      onError: (error) => {
        errors.push(error)
        complete.reject(error)
      },
      prepare: async (file) => [new File([await file.text()], file.name, { type: "text/plain" })],
      picker: async (input, onFile) => {
        options.push(input)
        for (const file of selected) await onFile(file)
        complete.resolve()
      },
    }),
  }))
  try {
    ctx.attachments.pick(() => {
      throw new Error("Unexpected browser fallback")
    })
    await complete.promise
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ multiple: true })
    expect(options[0]).not.toHaveProperty("defaultPath")
    expect(prompt.map((part) => (part.type === "image" ? part.filename : "unexpected"))).toEqual(
      selected.map((file) => file.name),
    )
    expect(ctx.attachments.jobs()).toEqual([])
    expect(errors).toEqual([])
  } finally {
    ctx.dispose()
  }
})
