import { onCleanup, onMount } from "solid-js"

/** Capped digital rain; hidden, unfocused and reduced-motion views do not animate. */
export function EmptyBinaryBackground() {
  let canvas: HTMLCanvasElement | undefined
  onMount(() => {
    const element = canvas!
    const context = element.getContext("2d")
    if (!context) return
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let width = 0
    let height = 0
    let phase = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const draw = () => {
      context.clearRect(0, 0, width, height)
      context.fillStyle = getComputedStyle(element).color
      context.font = "11px monospace"
      for (let column = 0; column * 18 < width; column++) {
        const head = (column * 137 + phase * (0.6 + (column % 5) * 0.12)) % (height + 240)
        const length = 9 + ((column * 7) % 9)
        for (let row = 0; row < length; row++) {
          const y = head - row * 18
          if (y < 0 || y > height) continue
          context.globalAlpha = (1 - row / length) * (row === 0 ? 1 : 0.75)
          context.fillText((column * 17 + row * 31) % 7 < 3 ? "0" : "1", column * 18 + 5, y)
        }
      }
      context.globalAlpha = 1
    }
    const resize = () => {
      const box = element.getBoundingClientRect()
      width = box.width
      height = box.height
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      draw()
    }
    const tick = () => {
      phase += 5
      draw()
      timer = setTimeout(tick, 80)
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = undefined
      draw()
      if (!motion.matches && !document.hidden && document.hasFocus()) timer = setTimeout(tick, 80)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-scheme"],
    })
    window.addEventListener("resize", resize)
    window.addEventListener("focus", schedule)
    window.addEventListener("blur", schedule)
    document.addEventListener("visibilitychange", schedule)
    motion.addEventListener("change", schedule)
    resize()
    schedule()
    onCleanup(() => {
      clearTimeout(timer)
      observer.disconnect()
      theme.disconnect()
      window.removeEventListener("resize", resize)
      window.removeEventListener("focus", schedule)
      window.removeEventListener("blur", schedule)
      document.removeEventListener("visibilitychange", schedule)
      motion.removeEventListener("change", schedule)
    })
  })
  return <canvas ref={canvas} aria-hidden="true" data-component="empty-binary-background" />
}
