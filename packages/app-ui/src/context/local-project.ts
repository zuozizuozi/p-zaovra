import type { Project } from "@zaovra-ai/sdk/v2/client"
import type { ProjectMeta } from "./global-sync/types"

export function enrichLocalProject(
  project: { worktree: string; expanded: boolean },
  metadata: Project | undefined,
  local: ProjectMeta | undefined,
  icon: string | undefined,
) {
  const override = !metadata?.id || metadata.id === "global" ? local : undefined
  const base = {
    ...project,
    ...metadata,
    ...override,
    worktree: project.worktree,
    expanded: project.expanded,
    icon: { ...metadata?.icon, ...override?.icon },
  }
  return icon ? { ...base, icon: { ...base.icon, override: icon } } : base
}
