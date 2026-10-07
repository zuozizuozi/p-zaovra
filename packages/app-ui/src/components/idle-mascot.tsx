import { BrandMark } from "./brand-mark"
import "./idle-mascot.css"

/** The welcome companion, separate from the static application brand. */
export function IdleMascot(props: { class?: string }) {
  return (
    <span data-component="idle-mascot" class={props.class} aria-hidden="true">
      <BrandMark class="size-full" />
      <span data-slot="mascot-eyelid" data-eye="left" />
      <span data-slot="mascot-eyelid" data-eye="right" />
    </span>
  )
}
