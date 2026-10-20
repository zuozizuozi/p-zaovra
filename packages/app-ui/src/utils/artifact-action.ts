import { artifactPath, artifactPreviewable } from "./artifact-path"

type Host = {
  openLink(url: string): void
  openPath?(path: string): Promise<void>
  revealPath?(path: string): Promise<boolean>
}

export function createArtifactAction(host: Host, failed: () => void) {
  const pending = new Set<string>()
  return async (target: string, directory: string) => {
    if (pending.has(target)) return
    pending.add(target)
    await Promise.resolve().then(async () => {
      if (/^https?:\/\//i.test(target)) return host.openLink(target)
      const path = artifactPath(target, directory)?.path
      if (!path || !artifactPreviewable(path)) throw new Error("Unsupported artifact path")
      if (!(await host.revealPath?.(`${directory.replace(/[\\/]$/, "")}/${path}`))) {
        throw new Error("Artifact could not be revealed")
      }
    }).catch(failed).finally(() => pending.delete(target))
  }
}
