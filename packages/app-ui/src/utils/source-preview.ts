/** A source module entry needs its bundler; ordinary static HTML is still previewable. */
export function sourcePreviewNeedsBuild(path: string, html: string, manifest: string) {
  if (/(?:^|\/)(?:dist|build|out)\//i.test(path.replaceAll("\\", "/"))) return false
  if (!/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>/i.test(html)) return false
  return /"(?:vite|webpack|parcel|@angular\/build)"\s*:|"(?:dev|build)"\s*:\s*"[^"\r\n]*\b(?:vite|webpack|parcel)\b/i.test(
    manifest,
  )
}
