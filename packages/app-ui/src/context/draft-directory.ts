import { isDirectoryUnavailableError } from "@/utils/server-errors"

/** Only a confirmed missing directory permits falling back to another project. */
export async function resolveDraftDirectory(input: {
  directory: string
  alternatives: string[]
  check: (directory: string) => Promise<unknown>
}) {
  for (const directory of new Set([input.directory, ...input.alternatives])) {
    if (!directory) continue
    try {
      await input.check(directory)
      return directory
    } catch (error) {
      // Authentication, permissions and connection failures belong to the normal
      // error view; they are not evidence that a project has been deleted.
      if (!isDirectoryUnavailableError(error, directory)) return directory
    }
  }
}
