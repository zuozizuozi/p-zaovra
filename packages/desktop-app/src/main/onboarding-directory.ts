export async function completeFirstLaunch(input: {
  pending: boolean
  create: boolean
  complete: () => void
}): Promise<null | { directory: string; fallback: boolean } | { needsDirectory: true }> {
  if (!input.pending) return null
  if (!input.create) {
    input.complete()
    return null
  }
  // Keep onboarding pending until the user picks a location or explicitly skips.
  return { needsDirectory: true }
}
