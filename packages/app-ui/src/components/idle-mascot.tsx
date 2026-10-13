import { TaskMascot } from "./task-mascot"
import "./idle-mascot.css"

/** The welcome companion, separate from the static application brand. */
export function IdleMascot(props: { class?: string }) {
  return (
    <span data-component="idle-mascot" class={props.class} aria-hidden="true">
      <TaskMascot state="idle" />
    </span>
  )
}
