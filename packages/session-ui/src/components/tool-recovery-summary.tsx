import type { ToolPart } from "@zaovra-ai/sdk/v2"
import { For, Show } from "solid-js"
import { Collapsible } from "@zaovra-ai/ui/collapsible"
import { Icon } from "@zaovra-ai/ui/icon"
import { useI18n } from "@zaovra-ai/ui/context/i18n"

export function ToolRecoverySummary(props: {
  parts: readonly ToolPart[]
  recovered?: boolean
  onSizeChange?: () => void
}) {
  const i18n = useI18n()
  return (
    <Collapsible data-component="tool-recovery-summary" onOpenChange={() => props.onSizeChange?.()}>
      <Collapsible.Trigger>
        <Show when={props.recovered !== false}>
          <Icon name="check" size="small" />
        </Show>
        <span>
          {i18n.t(props.recovered === false ? "ui.toolRecovery.exploratory" : "ui.toolRecovery.summary", {
            count: props.parts.length,
          })}
        </span>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <For each={props.parts}>
          {(part) => (
            <div data-slot="tool-recovery-attempt">
              <span>{part.tool}</span>
              <div>
                {part.id} · {part.callID}
              </div>
              <pre>{JSON.stringify(part.state.input, null, 2)}</pre>
              <pre>{part.state.status === "error" ? part.state.error : ""}</pre>
            </div>
          )}
        </For>
      </Collapsible.Content>
    </Collapsible>
  )
}
