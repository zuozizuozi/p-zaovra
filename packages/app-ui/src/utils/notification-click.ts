let cancelFocus: (() => void) | undefined

let nav: ((href: string) => void) | undefined

export const setNavigate = (fn: ((href: string) => void) | undefined) => {
  nav = fn
}

export const handleNotificationClick = (href?: string) => {
  window.focus()
  if (!href) return
  cancelFocus?.()
  if (nav) {
    window.dispatchEvent(new CustomEvent("zaovra:settings-close"))
    nav(href)
    const target = href.match(/#(question|permission)=([^#]+)$/)
    if (!target) return
    const key = `${target[1]}:${decodeURIComponent(target[2])}`
    const focus = () => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-notification-target]")).find(
        (el) => el.dataset.notificationTarget === key,
      )
      if (!card) return false
      const control =
        card.querySelector<HTMLElement>('button[data-slot="question-option"]:not(:disabled)') ??
        card.querySelector<HTMLElement>("textarea:not(:disabled), button:not(:disabled)")
      if (!control) return false
      for (let node: HTMLElement | null = control; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (
          node.hidden ||
          node.inert ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        )
          return false
      }
      card.scrollIntoView({ block: "nearest" })
      control.focus({ preventScroll: true })
      return true
    }
    if (focus()) return
    // Navigation and request loading may finish after the OS click arrives.
    const observer = new MutationObserver(() => {
      if (focus()) cancelFocus?.()
    })
    const timeout = setTimeout(() => cancelFocus?.(), 10000)
    cancelFocus = () => {
      observer.disconnect()
      clearTimeout(timeout)
      cancelFocus = undefined
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "class", "style", "hidden", "inert", "open"],
    })
    return
  }
  console.warn("notification-click: navigate function not set, falling back to window.location.assign")
  window.location.assign(href)
}
