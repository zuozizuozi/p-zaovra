export function createTimelineFrame<T extends HTMLElement>(options: {
  measure: (element: T) => void
  follow: () => void
  shouldFollow: () => boolean
}) {
  const elements = new Set<T>()
  let frame: number | undefined
  let requested = false
  let disposed = false
  const schedule = () => {
    if (disposed || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      const pending = [...elements]
      elements.clear()
      pending.forEach((element) => {
        if (element.isConnected) options.measure(element)
      })
      const follow = requested
      requested = false
      // Read user intent after measurement: a wheel gesture may have happened since scheduling.
      if (follow && options.shouldFollow()) options.follow()
      frame = undefined
      if (elements.size || requested) schedule()
    })
  }
  return {
    measure(element: T) {
      if (disposed || !element.isConnected) return
      elements.add(element)
      schedule()
    },
    follow() {
      if (disposed) return
      requested = true
      schedule()
    },
    dispose() {
      disposed = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      requested = false
      elements.clear()
    },
  }
}
