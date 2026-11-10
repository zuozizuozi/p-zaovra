import { For, Show } from "solid-js"
import { Icon } from "@zaovra-ai/ui/icon"
import { useLanguage } from "@/context/language"

export function SessionPanelControls(props: {
  hasChanges: boolean
  terminal: boolean
  opened: boolean
  onFiles: () => void
  onChanges: () => void
  onContext: () => void
  onTerminal: () => void
}) {
  const language = useLanguage()
  return (
    <div data-component="session-panel-controls" class="flex shrink-0 items-center gap-0.5">
      <For
        each={
          [
            { key: "command.file.open", icon: "folder" as const, action: props.onFiles, visible: true },
            {
              key: "command.review.toggle",
              icon: "review" as const,
              action: props.onChanges,
              visible: props.hasChanges,
            },
            { key: "session.tab.context", icon: "brain" as const, action: props.onContext, visible: true },
            {
              key: "command.terminal.toggle",
              icon: "terminal" as const,
              action: props.onTerminal,
              visible: props.terminal,
            },
          ] as const
        }
      >
        {(item) => (
          <Show when={item.visible}>
            <button
              type="button"
              class="flex size-10 items-center justify-center rounded-lg text-text-weak hover:bg-background-stronger hover:text-text-strong focus-visible:outline-2 focus-visible:outline-border-active"
              aria-label={language.t(item.key)}
              title={language.t(item.key)}
              aria-expanded={item.key !== "command.terminal.toggle" ? props.opened : undefined}
              aria-controls={item.key === "command.terminal.toggle" ? "terminal-panel" : "review-panel"}
              onClick={item.action}
            >
              <Icon name={item.icon} />
            </button>
          </Show>
        )}
      </For>
    </div>
  )
}
