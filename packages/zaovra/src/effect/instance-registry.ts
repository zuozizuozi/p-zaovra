const disposers = new Set<(directory: string) => Promise<void>>()
const directories = new Set<string>()

export function trackInstance(directory: string) {
  directories.add(directory)
}

export function instanceDirectories() {
  return [...directories]
}

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  directories.delete(directory)
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
}
