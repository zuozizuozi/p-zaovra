import { createEffect, createUniqueId, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { MascotSvg } from "./mascot/mascot-svg"
import { createMascotRig, type MascotPose } from "./mascot/rig"
import "./task-mascot.css"

export type MascotState = "idle" | "thinking" | "working" | "success" | "error" | "awaiting"

/**
 * 小造, the Zaovra mascot. `working` (a tool is running) shows the orbit; `output` marks a thinking turn that is
 * streaming text, which switches to the reading pose with the typing `>_` badge.
 */
export function TaskMascot(props: { state: MascotState; size?: "large"; animated?: boolean; output?: boolean }) {
  let element!: HTMLSpanElement
  let svg!: SVGSVGElement
  const id = createUniqueId()
  const [view, setView] = createStore({ visible: false, reduced: true, compact: false, ready: false })
  const pose = (): MascotPose => {
    if (props.state === "working") return "processing"
    if (props.state === "thinking" && props.output) return "speaking"
    return props.state
  }

  onMount(() => {
    const rig = createMascotRig(svg)
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const intersection = { on: false }
    const update = () => setView({ visible: intersection.on && !document.hidden, reduced: media.matches })
    const observer = new IntersectionObserver(([entry]) => {
      intersection.on = entry.isIntersecting
      update()
    })
    // Below ~30px the badges and highlights turn to noise, so crop to the body and drop them.
    const resize = new ResizeObserver(() => {
      rig.setWidth(element.clientWidth)
      setView("compact", element.clientWidth > 0 && element.clientWidth < 30)
    })
    observer.observe(element)
    resize.observe(element)
    document.addEventListener("visibilitychange", update)
    media.addEventListener("change", update)
    update()
    setView("ready", true)
    createEffect(() => rig.setPose(pose()))
    createEffect(() => rig.setStill(!view.visible || view.reduced || props.animated === false))
    onCleanup(() => {
      rig.dispose()
      observer.disconnect()
      resize.disconnect()
      document.removeEventListener("visibilitychange", update)
      media.removeEventListener("change", update)
    })
  })
  createEffect(() => {
    if (!view.ready) return
    svg.setAttribute("viewBox", view.compact ? "20 36 196 196" : "0 0 256 256")
  })

  return (
    <span
      ref={element}
      data-component="task-mascot"
      data-state={props.state}
      data-pose={pose()}
      data-size={props.size}
      data-compact={view.compact ? "" : undefined}
      data-motion={view.visible && !view.reduced && props.animated !== false ? "running" : "paused"}
      aria-hidden="true"
    >
      <MascotSvg id={id} ref={(node) => (svg = node)} />
    </span>
  )
}
