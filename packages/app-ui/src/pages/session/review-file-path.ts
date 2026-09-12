// Review paths are relative to the project worktree, while the file SDK is location-scoped.
export function resolveReviewFilePath(worktree: string, file: string) {
  if (/^(?:[A-Za-z]:[/\\]|[/\\])/.test(file)) return file
  return `${worktree.replace(/[/\\]+$/, "")}/${file}`
}
