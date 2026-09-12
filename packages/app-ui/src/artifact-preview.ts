export type ArtifactBounds = { x: number; y: number; width: number; height: number }
export type ArtifactState = { title: string; url: string; loading: boolean; error?: string; zoom: number }
export type ArtifactPreviewAPI = {
  readPDF(input: { target: string; directory: string }): Promise<ArrayBuffer>
  open(input: { id: string; target: string; directory: string }): Promise<void>
  bounds(input: { id: string; bounds: ArtifactBounds; visible: boolean }): Promise<void>
  action(input: { id: string; action: "reload" | "close" | "zoom-in" | "zoom-out" | "reset" }): Promise<void>
  state(id: string): Promise<ArtifactState | undefined>
}
