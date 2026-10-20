import { onCleanup, onMount } from "solid-js"

/** Static binary texture: no animation loop, including while unfocused or hidden. */
export function EmptyBinaryBackground() {
  let canvas: HTMLCanvasElement | undefined
  onMount(() => {
    const element = canvas!
    const draw = () => {
      const box = element.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      element.width = Math.round(box.width * ratio)
      element.height = Math.round(box.height * ratio)
      const context = element.getContext("2d")
      if (!context) return
      context.scale(ratio, ratio)
      context.fillStyle = getComputedStyle(element).color
      context.font = "11px monospace"
      for (let y = 14; y < box.height; y += 18) {
        for (let x = 5; x < box.width; x += 13) {
          context.fillText(((x * 17 + y * 31) % 7) < 3 ? "0" : "1", x, y)
        }
      }
    }
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    // Theme changes can replace inherited tokens without changing canvas dimensions.
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-scheme"] })
    window.addEventListener("resize", draw)
    draw()
    onCleanup(() => {
      observer.disconnect()
      theme.disconnect()
      window.removeEventListener("resize", draw)
    })
  })
  return <canvas ref={canvas} aria-hidden="true" data-component="empty-binary-background" />
}