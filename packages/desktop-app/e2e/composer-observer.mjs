// Observe the real renderer without replacing its state, event handlers or clock.
export async function observeComposer(page) {
  return page.evaluateHandle(() => {
    const frames = []
    const changes = []
    const pointers = []
    let tag = "initial"
    let previous = ""
    let frame
    let stopped = false
    let overflow = false
    const visible = (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden"
    const status = () => {
      const text = [...document.querySelectorAll('[data-slot="assistant-heading"], [role="status"]')]
        .filter(visible)
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean)
      const key = JSON.stringify(text)
      if (key === previous) return
      previous = key
      if (changes.length >= 10000) {
        overflow = true
        return
      }
      changes.push({ at: performance.now(), tag, text })
    }
    const sample = () => {
      if (stopped) return
      if (frames.length >= 30000) {
        overflow = true
        return
      }
      const input = document.querySelector('[data-component="prompt-input"][contenteditable="true"]')
      const form = input?.closest("form")
      const button =
        document.querySelector('[data-slot="prompt-submit-slot"]') ??
        document.querySelector('[data-action="prompt-submit"], [data-action="prompt-stop"]')
      const usage = document.querySelector(".session-usage-bar")
      frames.push({
        at: performance.now(),
        tag,
        width: innerWidth,
        height: innerHeight,
        visible: document.visibilityState,
        formBottom: form?.getBoundingClientRect().bottom,
        buttonBottom: button?.getBoundingClientRect().bottom,
        inputConnected: !!input?.isConnected,
        usageVisible: !!usage && !!visible(usage),
        usageText: usage?.textContent,
      })
      status()
      frame = requestAnimationFrame(sample)
    }
    const pointer = (event) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest('[data-action="prompt-submit"]')) return
      pointers.push({
        at: performance.now(),
        tag,
        type: event.type,
        trusted: event.isTrusted,
        x: event.clientX,
        y: event.clientY,
      })
    }
    for (const type of ["pointerdown", "pointerup", "click"]) document.addEventListener(type, pointer, true)
    const observer = new MutationObserver(status)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    frame = requestAnimationFrame(sample)
    return {
      mark(value) {
        tag = value
        previous = ""
        status()
      },
      stop() {
        stopped = true
        cancelAnimationFrame(frame)
        observer.disconnect()
        for (const type of ["pointerdown", "pointerup", "click"]) document.removeEventListener(type, pointer, true)
        return { frames, changes, pointers, overflow }
      },
    }
  })
}
