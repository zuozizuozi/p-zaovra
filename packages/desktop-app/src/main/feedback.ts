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
