// Ghostty suppresses resize events for 50ms after fitting. Observe the host ourselves
// and fit after its last geometry change, including changes during that suppression.
export function observeTerminalFit(container: HTMLElement, fit: () => void) {
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const run = () => {
    if (disposed || container.clientWidth <= 0 || container.clientHeight <= 0) return
    fit()
  }
  const schedule = () => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        run()
      })
    }, 75)
  }
  const observer = new ResizeObserver(schedule)
  observer.observe(container)
  window.addEventListener("resize", schedule)
  return {
    fit: run,
    schedule,
    dispose: () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener("resize", schedule)
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
