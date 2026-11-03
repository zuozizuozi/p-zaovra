import { Feedback } from "@zaovra-ai/schema/feedback"
import { BlobReader, BlobWriter, ZipWriter } from "@zip.js/zip.js"

export async function feedbackArchive(snapshot: Feedback.Snapshot) {
  if (!Feedback.validSnapshot(snapshot)) throw new Error("Invalid feedback preview")
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const file of snapshot.files)
    await writer.add(file.name, new BlobReader(new Blob([file.text])), { useWebWorkers: false })
  if (snapshot.image) {
    const bytes = Uint8Array.from(atob(snapshot.image.split(",")[1]), (value) => value.charCodeAt(0))
    await writer.add("screenshot.png", new BlobReader(new Blob([bytes])), { useWebWorkers: false })
  }
  return writer.close()
}

export async function submitFeedback(
  snapshot: unknown,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
) {
  if (!Feedback.validSnapshot(snapshot)) throw new Error("Invalid feedback preview")
  const response = await fetcher("https://feedback.zaovra.com/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  })
  if (!response.ok || Number(response.headers.get("content-length")) > 2048)
    throw new Error("Feedback submission failed")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing feedback receipt")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2048) throw new Error("Invalid feedback receipt")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(size)
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  const result: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (
    !result ||
    typeof result !== "object" ||
    !("submitted" in result) ||
    result.submitted !== true ||
    !("receipt" in result) ||
    typeof result.receipt !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.receipt)
  )
    throw new Error("Invalid feedback receipt")
  return { receipt: result.receipt, submitted: true as const }
}
