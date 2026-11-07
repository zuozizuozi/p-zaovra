import { Show } from "solid-js"
import { Icon } from "@zaovra-ai/ui/icon"
import { IconButton } from "@zaovra-ai/ui/icon-button"
import { Tooltip } from "@zaovra-ai/ui/tooltip"

export function PromptActions(props: {
  working: boolean
  blank: boolean
  shell: boolean
  tabIndex?: number
  stopLabel: string
  sendLabel: string
  escapeLabel: string
  onStop: () => void
}) {
  return (
    <>
      <Show when={props.working}>
        <Tooltip
          placement="top"
          value={
            <div class="flex items-center gap-2">
              <span>{props.stopLabel}</span>
              <span class="text-icon-base text-12-medium text-[10px]!">{props.escapeLabel}</span>
            </div>
          }
        >
          <IconButton
            data-action="prompt-stop"
            type="button"
            tabIndex={props.tabIndex}
            icon="stop"
            variant={props.blank ? "primary" : "secondary"}
            class="size-8"
            aria-label={props.stopLabel}
            onClick={props.onStop}
          />
        </Tooltip>
      </Show>
      <Show when={!props.working || !props.blank}>
        <Tooltip
          placement="top"
          inactive={props.blank}
          value={
            <div class="flex items-center gap-2">
              <span>{props.sendLabel}</span>
              <Icon name="enter" size="small" class="text-icon-base" />
            </div>
          }
        >
          <IconButton
            data-action="prompt-submit"
            type="submit"
            disabled={props.blank}
            tabIndex={props.tabIndex}
            icon={props.shell ? "arrow-undo-down" : "arrow-up"}
            variant="primary"
            class="size-8"
            aria-label={props.sendLabel}
          />
        </Tooltip>
      </Show>
    </>
  )
}
