import type { FileContent } from "@zaovra-ai/sdk/v2"

export function artifactLines(file: FileContent) {
  if (file.type !== "text" || file.encoding === "base64" || file.content.includes("\0")) return undefined
  if (!file.content) return 0
  return file.content.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(file.content) ? 1 : 0)
}
