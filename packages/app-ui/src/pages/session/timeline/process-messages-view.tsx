import { For, Show } from "solid-js"
import type { processMessages } from "./process-messages"

export function ProcessMessages(props: { entries: ReturnType<typeof processMessages> }) {
  return (
    <Show when={props.entries.length}>
      <details data-component="process-messages" class="text-xs text-text-weak py-2">
        <summary class="cursor-pointer">过程记录（{props.entries.length}）</summary>
        <div class="flex flex-col gap-2 pt-2">
          <For each={props.entries}>
            {(entry) => (
              <details
                data-component="process-message"
                data-job-id={entry.id}
                class="rounded border border-border-weak-base p-2"
              >
                <summary class="cursor-pointer break-words">
                  {entry.title} · {entry.pending ? "运行中" : "已记录"}
                </summary>
                <pre data-scrollable class="max-h-64 overflow-auto whitespace-pre-wrap break-words pt-2">
                  {entry.text}
                </pre>
              </details>
            )}
          </For>
        </div>
      </details>
    </Show>
  )
}
