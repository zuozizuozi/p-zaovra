import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { BrandMark } from "./brand-mark"
import thinking from "@/assets/zaovra-thinking-128.webp"
import thinking2x from "@/assets/zaovra-thinking-256.webp"
import success from "@/assets/zaovra-success-128.webp"
import success2x from "@/assets/zaovra-success-256.webp"
import error from "@/assets/zaovra-error-128.webp"
import error2x from "@/assets/zaovra-error-256.webp"
import awaiting from "@/assets/zaovra-awaiting-128.webp"
import awaiting2x from "@/assets/zaovra-awaiting-256.webp"
import "./task-mascot.css"

export type MascotState = "idle" | "thinking" | "working" | "success" | "error" | "awaiting"
const pictures = {
  thinking: [thinking, thinking2x],
  success: [success, success2x],
  error: [error, error2x],
  awaiting: [awaiting, awaiting2x],
}

export function TaskMascot(props: { state: MascotState; size?: "large"; animated?: boolean }) {
  let element!: HTMLSpanElement
  const [motion, setMotion] = createStore({ visible: false, reduced: true, blink: "" })
  onMount(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    let intersecting = false
    const update = () => setMotion({ visible: intersecting && !document.hidden, reduced: media.matches })
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting
      update()
    })
    observer.observe(element)
    document.addEventListener("visibilitychange", update)
    media.addEventListener("change", update)
    update()
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", update)
      media.removeEventListener("change", update)
    })
  })
  createEffect(() => {
    if (!motion.visible || motion.reduced || props.animated === false) {
      setMotion("blink", "")
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const schedule = (elapsed = 0) => {
      timer = setTimeout(
        () => {
          setMotion("blink", Math.random() < 0.2 ? "double" : "single")
          timer = setTimeout(() => {
            setMotion("blink", "")
            schedule(440)
          }, 440)
        },
        3000 + Math.random() * 3000 - elapsed,
      )
    }
    schedule()
    onCleanup(() => clearTimeout(timer))
  })
  const picture = () => (props.state === "idle" || props.state === "working" ? undefined : pictures[props.state])
  return (
    <span
      ref={element}
      data-component="task-mascot"
      data-state={props.state}
      data-size={props.size}
      data-motion={motion.visible && !motion.reduced && props.animated !== false ? "running" : "paused"}
      data-blink={motion.blink}
      aria-hidden="true"
    >
      <Show when={picture()} fallback={<BrandMark class="size-full" />}>
        {(image) => <img src={image()[0]} srcset={`${image()[0]} 1x, ${image()[1]} 2x`} alt="" />}
      </Show>
      <Show when={picture() && ["awaiting", "error", "success"].includes(props.state)}>
        <span data-slot="mascot-mark">
          <img src={picture()![0]} srcset={`${picture()![0]} 1x, ${picture()![1]} 2x`} alt="" />
        </span>
        <Show when={props.state === "success"}>
          <span data-slot="mascot-mark" data-ray="2">
            <img src={success} srcset={`${success} 1x, ${success2x} 2x`} alt="" />
          </span>
          <span data-slot="mascot-mark" data-ray="3">
            <img src={success} srcset={`${success} 1x, ${success2x} 2x`} alt="" />
          </span>
        </Show>
      </Show>
      <span data-slot="mascot-eyelid" data-eye="left" />
      <span data-slot="mascot-eyelid" data-eye="right" />
      <Show when={props.state === "working"}>
        <span data-slot="mascot-cursor">&gt;_</span>
      </Show>
      <Show when={props.state === "thinking"}>
        <span data-slot="mascot-dots">
          <i />
          <i />
          <i />
        </span>
      </Show>
    </span>
  )
}
