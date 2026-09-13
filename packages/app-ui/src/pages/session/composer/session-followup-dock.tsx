import { For, Show, createMemo, createUniqueId } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@zaovra-ai/ui/button"
import { DockTray } from "@zaovra-ai/ui/dock-surface"
import { Icon } from "@zaovra-ai/ui/icon"
import { IconButton } from "@zaovra-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const language = useLanguage()
  const listID = createUniqueId()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray
      data-component="session-followup-dock"
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <button
        type="button"
        class="w-full pl-3 pr-2 py-2 flex items-center gap-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-active"
        aria-expanded={!store.collapsed}
        aria-controls={listID}
        onClick={toggle}
      >
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <span
          class="ml-auto shrink-0"
          aria-hidden="true"
          style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
        >
          <Icon name="chevron-down" size="normal" />
        </span>
      </button>

      <Show when={store.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!store.collapsed}>
        <div
          id={listID}
          aria-busy={!!props.sending}
          class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar"
        >
          <p class="text-12-regular text-text-weak">{language.t("session.followupDock.hint")}</p>
          <For each={props.items}>
            {(item) => (
              <div class="flex items-center gap-2 min-w-0 py-1">
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong" title={item.text}>
                  {item.text}
                </span>
                <Button
                  size="small"
                  variant="secondary"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onSend(item.id)}
                >
                  {language.t("session.followupDock.sendNow")}
                </Button>
                <IconButton
                  icon="close"
                  variant="ghost"
                  size="small"
                  disabled={!!props.sending}
                  aria-label={language.t("session.followupDock.remove")}
                  onClick={() => props.onRemove(item.id)}
                />
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={!!props.sending}
                  onClick={() => props.onEdit(item.id)}
                >
                  {language.t("session.followupDock.edit")}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
