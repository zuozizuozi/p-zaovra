import { createQuery } from "@tanstack/solid-query"
import type { ZaovraClient } from "@zaovra-ai/sdk/v2"

type ReviewMode = "git" | "branch" | "turn"

export function createReviewEntry(input: {
  workspace: () => { key: readonly unknown[]; git: boolean; client: Pick<ZaovraClient, "vcs"> }
  reviewCount: () => number
  turnCount: () => number
  setMode: (mode: ReviewMode) => void
}) {
  const query = createQuery(() => {
    const workspace = input.workspace()
    return {
      queryKey: [...workspace.key, "status"],
      enabled: workspace.git,
      // Navigation needs only file status; patches stay lazy until Review opens.
      queryFn: () => workspace.client.vcs.status(undefined, { throwOnError: true }).then((result) => result.data),
      staleTime: 10_000,
      refetchOnMount: "always" as const,
      refetchOnWindowFocus: true,
      throwOnError: false,
    }
  })
  const workspaceChanged = () => input.workspace().git && query.isFetched && (query.data?.length ?? 0) > 0
  return {
    query,
    hasChanges: () => input.reviewCount() > 0 || input.turnCount() > 0 || workspaceChanged(),
    select: () => {
      if (input.reviewCount() > 0) return
      if (input.turnCount() > 0) return input.setMode("turn")
      if (workspaceChanged()) input.setMode("git")
    },
  }
}
