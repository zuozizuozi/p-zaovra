import { pathsEqual } from "@/utils/path-key"

export function desktopProjectGroup<T extends { server: string; project: { worktree: string; sandboxes?: string[] } }>(
  groups: T[],
  server: string,
  directory?: string,
) {
  const candidates = groups.filter((group) => group.server === server)
  if (!directory) return candidates[0]
  return (
    candidates.find(
      (group) =>
        pathsEqual(group.project.worktree, directory) ||
        group.project.sandboxes?.some((sandbox) => pathsEqual(sandbox, directory)),
    ) ?? candidates[0]
  )
}
