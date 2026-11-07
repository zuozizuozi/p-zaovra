import { SelectV2 } from "@zaovra-ai/ui/v2/select-v2"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { conversationViews, type ConversationView } from "@/utils/conversation-view"

export function ConversationViewSelect(props: {
  value: ConversationView | "default"
  temporary?: boolean
  onChange: (value: ConversationView | undefined) => void
}) {
  const language = useLanguage()
  const options = (): (ConversationView | "default")[] =>
    props.temporary ? ["default", ...conversationViews] : [...conversationViews]
  return (
    <div
      data-component="conversation-view"
      class="flex min-w-0 items-center gap-1.5"
      title={language.t(props.temporary ? "conversation.view.temporary" : "conversation.view.setting")}
    >
      <Show when={props.temporary}>
        <span class="text-xs text-text-weak">{language.t("conversation.view.label")}</span>
      </Show>
      <SelectV2
        data-action={props.temporary ? "session-conversation-view" : "settings-conversation-view"}
        aria-label={language.t(props.temporary ? "conversation.view.temporary" : "conversation.view.setting")}
        appearance="inline"
        options={options()}
        current={props.value}
        placement="bottom-end"
        label={(value) => language.t(`conversation.view.${value}`)}
        onSelect={(value) => {
          if (value) props.onChange(value === "default" ? undefined : value)
        }}
      />
    </div>
  )
}
