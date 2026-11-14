import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import type { MemoryRecovery } from "@zaovra-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"

export function MemoryRecoveryPanel(props: {
  data: MemoryRecovery
  resolve: (decision: "restore" | "blank", ids: string[]) => Promise<boolean>
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ selected: [] as string[], busy: false, blank: false, error: false })
  const submit = async (decision: "restore" | "blank") => {
    if (state.busy) return
    setState({ busy: true, error: false })
    await props.resolve(decision, decision === "blank" ? [] : state.selected).then(
      (accepted) => setState({ busy: false, error: !accepted, selected: accepted ? [] : state.selected, blank: false }),
      () => setState({ busy: false, error: true }),
    )
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(props.data, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = "legacy-memory.json"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section data-slot="memory-recovery" class="flex flex-col gap-3 rounded-lg border border-v2-border-base p-4">
      <h3 class="text-sm font-medium">{language.t("settings.memory.recovery.title")}</h3>
      <p class="text-xs">{language.t("settings.memory.recovery.warning")}</p>
      <p class="break-all text-xs">{props.data.directory}</p>
      <p class="text-xs">
        {language.t(props.data.frozen ? "settings.memory.recovery.frozen" : "settings.memory.recovery.ready")}
      </p>
      <Show when={props.data.automaticFrozen}>
        <p class="text-xs">{language.t("settings.memory.recovery.automaticFrozen")}</p>
      </Show>
      <ButtonV2 variant="neutral" onClick={download}>
        {language.t("settings.memory.recovery.export")}
      </ButtonV2>
      <For each={props.data.notes}>
        {(entry) => (
          <label class="flex items-start gap-2 text-sm" data-slot="memory-recovery-note">
            <input
              type="checkbox"
              disabled={!entry.restorable || state.busy}
              checked={state.selected.includes(entry.note.id)}
              onChange={(event) =>
                setState(
                  "selected",
                  event.currentTarget.checked
                    ? [...state.selected, entry.note.id]
                    : state.selected.filter((id) => id !== entry.note.id),
                )
              }
            />
            <span class="flex flex-col gap-1">
              <span class="break-words">{entry.note.text}</span>
              <span class="break-all text-xs text-v2-text-text-muted">
                {entry.sourceDirectory ?? language.t("settings.memory.recovery.unknown")}
              </span>
              <Show when={!entry.restorable}>
                <span class="text-xs">
                  {language.t(
                    entry.restored ? "settings.memory.recovery.processed" : "settings.memory.recovery.readonly",
                  )}
                </span>
              </Show>
            </span>
          </label>
        )}
      </For>
      <p class="text-xs">
        {language.t("settings.memory.recovery.deleted")} {props.data.deleted}
      </p>
      <Show when={state.error}>
        <p role="alert" class="text-xs">
          {language.t("settings.memory.recovery.failed")}
        </p>
      </Show>
      <div class="flex flex-wrap gap-2">
        <ButtonV2
          variant="neutral"
          disabled={state.busy || !state.selected.length}
          onClick={() => void submit("restore")}
        >
          {language.t("settings.memory.recovery.restore")}
        </ButtonV2>
        <Show when={props.data.frozen}>
          <Show
            when={state.blank}
            fallback={
              <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => setState("blank", true)}>
                {language.t("settings.memory.recovery.blank")}
              </ButtonV2>
            }
          >
            <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void submit("blank")}>
              {language.t("settings.memory.recovery.confirmBlank")}
            </ButtonV2>
            <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => setState("blank", false)}>
              {language.t("common.cancel")}
            </ButtonV2>
          </Show>
        </Show>
      </div>
    </section>
  )
}
