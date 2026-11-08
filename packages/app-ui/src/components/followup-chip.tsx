import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

/** Whether a message sent during a run waits for it to finish; only meaningful while a run is active. */
export function FollowupChip(props: { working: boolean }) {
  const language = useLanguage()
  const settings = useSettings()
  const queued = () => settings.general.followup() === "queue"
  return (
    <Show when={props.working}>
      <button
        type="button"
        data-component="followup-chip"
        aria-pressed={queued()}
        class="h-7 shrink-0 rounded-full px-2 text-xs"
        classList={{ "bg-v2-background-bg-layer-02": queued(), "text-text-weak": !queued() }}
        onClick={() => settings.general.setFollowup(queued() ? "steer" : "queue")}
      >
        {language.t("session.message.queueAfterTask")}
      </button>
    </Show>
  )
}
