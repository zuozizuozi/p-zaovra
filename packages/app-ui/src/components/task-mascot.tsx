import { Show } from "solid-js"
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

export function TaskMascot(props: { state: MascotState; size?: "large" }) {
  const picture = () => (props.state === "idle" || props.state === "working" ? undefined : pictures[props.state])
  return (
    <span data-component="task-mascot" data-state={props.state} data-size={props.size} aria-hidden="true">
      <Show when={picture()} fallback={<BrandMark class="size-full" />}>
        {(image) => <img src={image()[0]} srcset={`${image()[0]} 1x, ${image()[1]} 2x`} alt="" />}
      </Show>
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
