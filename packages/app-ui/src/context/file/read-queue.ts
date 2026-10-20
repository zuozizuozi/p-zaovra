export function createFileReadQueue() {
  const inflight = new Map<string, { generation: number; promise: Promise<void> }>()
  return {
    clear: () => inflight.clear(),
    run<T>(key: string, force: boolean, read: () => Promise<T>, loaded: (value: T) => void, failed: (error: unknown) => void) {
      const pending = inflight.get(key)
      if (pending) {
        if (force) pending.generation++
        return pending.promise
      }
      const entry = { generation: 0, promise: Promise.resolve() }
      inflight.set(key, entry)
      entry.promise = (async () => {
        while (inflight.get(key) === entry) {
          const generation = entry.generation
          const result = await Promise.resolve().then(read).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          if (inflight.get(key) !== entry) return
          // Multiple invalidations during one read require only one trailing read.
          if (generation !== entry.generation) continue
          if (result.ok) loaded(result.value)
          else failed(result.error)
          return
        }
      })().finally(() => {
        if (inflight.get(key) === entry) inflight.delete(key)
      })
      return entry.promise
    },
  }
}
