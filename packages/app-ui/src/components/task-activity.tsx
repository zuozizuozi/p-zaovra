import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { TaskMascot, type MascotState } from "./task-mascot"
import "./task-activity.css"

export function TaskActivity(props: { state: MascotState; tool?: string; started?: number }) {
  const language = useLanguage()
  const [clock, setClock] = createStore({ now: Date.now(), started: Date.now() })
  createEffect(
    on(
      () => [props.state, props.started] as const,
      () => {
        setClock({ now: Date.now(), started: props.started ?? Date.now() })
        if (!["thinking", "working", "awaiting"].includes(props.state)) return
        const timer = setInterval(() => setClock("now", Date.now()), 1000)
        onCleanup(() => clearInterval(timer))
      },
    ),
  )
  const seconds = () => Math.max(0, Math.floor((clock.now - clock.started) / 1000))
  return (
    <div data-component="task-activity" data-state={props.state}>
      <TaskMascot state={props.state} size="large" animated={props.state !== "idle"} />
      <span data-slot="activity-label" role="status" aria-live="polite">
        {language.t(`session.activity.${props.state}`)}
      </span>
      <Show when={seconds() >= 10 && ["thinking", "working", "awaiting"].includes(props.state)}>
        <Show when={props.tool}>
          <span data-slot="activity-command" title={props.tool}>
            {props.tool}
          </span>
        </Show>
        <span data-slot="activity-elapsed">{language.t("session.activity.elapsed", { seconds: seconds() })}</span>
      </Show>
    </div>
  )
}
