export type ArtifactBounds = { x: number; y: number; width: number; height: number }

export function artifactViewer(target: string) {
  if (/^https?:\/\//i.test(target)) return "browser"
  if (/\.pdf$/i.test(target)) return "pdf"
  return /\.(?:html?|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav)$/i.test(target) ? "browser" : "external"
}
export type ArtifactState = { title: string; url: string; loading: boolean; error?: string; zoom: number }
export type ArtifactPreviewAPI = {
  fileAction?(input: { target: string; directory: string; action: "open" | "reveal" }): Promise<void>
  readPDF(input: { target: string; directory: string }): Promise<ArrayBuffer>
  open(input: { id: string; target: string; directory: string }): Promise<void>
  bounds(input: { id: string; bounds: ArtifactBounds; visible: boolean }): Promise<void>
  action(input: { id: string; action: "reload" | "close" | "zoom-in" | "zoom-out" | "reset" }): Promise<void>
  state(id: string): Promise<ArtifactState | undefined>
}
