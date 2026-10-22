import type { ToolPart } from "@zaovra-ai/sdk/v2"
import { For } from "solid-js"
import { Collapsible } from "@zaovra-ai/ui/collapsible"
import { Icon } from "@zaovra-ai/ui/icon"
import { useI18n } from "@zaovra-ai/ui/context/i18n"

export function ToolRecoverySummary(props: { parts: readonly ToolPart[]; onSizeChange?: () => void }) {
  const i18n = useI18n()
  return (
    <Collapsible data-component="tool-recovery-summary" onOpenChange={() => props.onSizeChange?.()}>
      <Collapsible.Trigger>
        <Icon name="check" size="small" />
        <span>{i18n.t("ui.toolRecovery.summary", { count: props.parts.length })}</span>
        <Collapsible.Arrow />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <For each={props.parts}>
          {(part) => (
            <div data-slot="tool-recovery-attempt">
              <span>{part.tool}</span>
              <pre>{part.state.status === "error" ? part.state.error : ""}</pre>
            </div>
          )}
        </For>
      </Collapsible.Content>
    </Collapsible>
  )
}
