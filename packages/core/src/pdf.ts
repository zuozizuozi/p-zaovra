export * as Pdf from "./pdf"

import { Effect, Schema } from "effect"

export const MAX_BYTES = 20 * 1024 * 1024
const MAX_PAGES = 100
const MAX_CHARACTERS = 200_000

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("Pdf.DecodeError", {
  message: Schema.String,
}) {}

/** Text extraction is a fallback; it cannot describe scanned pages or images. */
export const text = Effect.fn("Pdf.text")(function* (data: Uint8Array) {
  if (data.byteLength > MAX_BYTES)
    return yield* new DecodeError({ message: "PDF exceeds the 20 MiB text extraction limit" })
  const { getDocumentProxy } = yield* Effect.promise(() => import("unpdf"))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const document = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => getDocumentProxy(new Uint8Array(data), { maxImageSize: 0, useSystemFonts: false }),
          catch: (error) =>
            new DecodeError({
              message: `Unable to read PDF: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }),
        (document) => Effect.promise(() => document.loadingTask.destroy()).pipe(Effect.ignore),
      )
      const pages: string[] = []
      let length = 0
      for (let number = 1; number <= Math.min(document.numPages, MAX_PAGES) && length < MAX_CHARACTERS; number++) {
        const page = yield* Effect.tryPromise({
          try: async () => {
            const page = await document.getPage(number)
            const content = await page.getTextContent()
            return content.items
              .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
              .join("")
              .trim()
          },
          catch: () => new DecodeError({ message: `Unable to extract text from PDF page ${number}` }),
        })
        pages.push(
          `[Page ${number}]\n${page || "No extractable text on this page; scanned images require a model with PDF input support."}`,
        )
        length += page.length
      }
      const truncated = pages.length < document.numPages || length > MAX_CHARACTERS
      return {
        text: pages.join("\n\n").slice(0, MAX_CHARACTERS) + (truncated ? "\n[PDF text extraction truncated]" : ""),
        pages: document.numPages,
        truncated,
      }
    }),
  )
})
