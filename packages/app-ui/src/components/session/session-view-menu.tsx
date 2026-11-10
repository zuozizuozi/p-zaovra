import { DropdownMenu } from "@zaovra-ai/ui/dropdown-menu"
import { Icon } from "@zaovra-ai/ui/icon"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { conversationViews, type ConversationView } from "@/utils/conversation-view"

export function SessionViewMenu(props: {
  modern: boolean
  value: ConversationView | undefined
  onChange: (value: ConversationView | undefined) => void
  reviewOpened: boolean
  onReviewToggle: () => void
}) {
  const language = useLanguage()
  const Menu = props.modern ? MenuV2 : DropdownMenu
  const options = ["default", ...conversationViews] as const
  return (
    <>
      <Menu.Group>
        <Menu.GroupLabel>{language.t("conversation.view.label")}</Menu.GroupLabel>
        <Menu.RadioGroup
          value={props.value ?? "default"}
          onChange={(value) => {
            if (value === "default") return props.onChange(undefined)
            if (conversationViews.some((view) => view === value)) props.onChange(value as ConversationView)
          }}
        >
          <For each={options}>
            {(value) => (
              <Menu.RadioItem value={value} textValue={language.t(`conversation.view.${value}`)}>
                {language.t(`conversation.view.${value}`)}
                <Show when={!props.modern}>
                  <DropdownMenu.ItemIndicator>
                    <Icon name="check-small" size="small" />
                  </DropdownMenu.ItemIndicator>
                </Show>
              </Menu.RadioItem>
            )}
          </For>
        </Menu.RadioGroup>
      </Menu.Group>
      <Menu.Separator />
      <Menu.CheckboxItem checked={props.reviewOpened} onChange={props.onReviewToggle}>
        {language.t("command.review.toggle")}
        <Show when={!props.modern}>
          <DropdownMenu.ItemIndicator>
            <Icon name="check-small" size="small" />
          </DropdownMenu.ItemIndicator>
        </Show>
      </Menu.CheckboxItem>
      <Menu.Separator />
    </>
  )
}
