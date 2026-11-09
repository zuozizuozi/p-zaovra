import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"

const dragType = "application/x-zaovra-sidebar"

export function SidebarReorder(props: {
  id: string
  scope: string
  label: string
  disabled?: boolean
  class?: string
  children: JSX.Element
  onMove: (source: string, target: string) => void
  onStep: (step: number) => void
}) {
  const [state, setState] = createStore({ over: false })
  return (
    <div
      data-slot="sidebar-reorder"
      data-reorder-id={props.id}
      class={props.class}
      classList={{ "outline outline-1 outline-border-focus": state.over }}
      draggable={!props.disabled}
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.label}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onDragStart={(event) => {
        if (props.disabled || (event.target instanceof Element && event.target.closest("input,textarea"))) {
          event.preventDefault()
          return
        }
        event.stopPropagation()
        event.dataTransfer?.setData(dragType, JSON.stringify(props.scope) + "\n" + props.id)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
      }}
      onDragOver={(event) => {
        if (props.disabled || !event.dataTransfer?.types.includes(dragType)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = "move"
        setState("over", true)
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setState("over", false)
      }}
      onDragEnd={() => setState("over", false)}
      onDrop={(event) => {
        setState("over", false)
        if (props.disabled) return
        const value = event.dataTransfer?.getData(dragType)
        if (!value) return
        // Only accept data written by a sidebar row, within the same list.
        const prefix = JSON.stringify(props.scope) + "\n"
        if (!value.startsWith(prefix)) return
        event.preventDefault()
        event.stopPropagation()
        props.onMove(value.slice(prefix.length), props.id)
      }}
      onKeyDown={(event) => {
        if (props.disabled || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.target instanceof Element && event.target.closest("input,textarea")) return
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        event.stopPropagation()
        props.onStep(event.key === "ArrowUp" ? -1 : 1)
      }}
    >
      {props.children}
    </div>
  )
}
