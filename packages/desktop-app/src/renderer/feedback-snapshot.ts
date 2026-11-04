import type { Feedback } from "@zaovra-ai/schema/feedback"

// Solid's store proxies cannot cross Electron's context bridge or IPC clone.
// Copy only the bounded, already-previewed fields; never read additional data.
export function feedbackIpcSnapshot(snapshot: Feedback.Snapshot): Feedback.Snapshot {
  return {
    text: snapshot.text,
    files: snapshot.files.map((file) => ({ name: file.name, text: file.text })),
    ...(snapshot.image ? { image: snapshot.image } : {}),
  }
}
