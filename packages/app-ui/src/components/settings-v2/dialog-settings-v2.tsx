import type { ServerConnection } from "@/context/server"
import { Component, For, Show, createEffect, createSignal, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { Dialog, DialogHeader, DialogTitle } from "@zaovra-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@zaovra-ai/ui/v2/tabs-v2"
import { Icon } from "@zaovra-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { UsageDashboard } from "../usage-dashboard"
import { SettingsAbout } from "./about"

export const DialogSettings: Component<{
  serverKey?: ServerConnection.Key
  serverLabel?: string
  sessionID?: string
  defaultValue?: string
  embedded?: boolean
  onClose?: () => void
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  createEffect(() => setTab(props.defaultValue ?? "general"))
  const [search, setSearch] = createStore({ value: "" })
  const groups = [
    {
      label: "settings.group.general",
      items: [
        { value: "general", label: "settings.tab.general", icon: "sliders" },
        { value: "appearance", label: "settings.general.section.appearance", icon: "eye" },
        { value: "shortcuts", label: "settings.tab.shortcuts", icon: "keyboard" },
      ],
    },
    {
      label: "settings.group.models",
      items: [
        { value: "providers", label: "settings.providers.title", icon: "providers" },
        { value: "models", label: "settings.models.title", icon: "models" },
        { value: "usage", label: "usage.title", icon: "bullet-list" },
      ],
    },
    {
      label: "settings.group.security",
      items: [
        { value: "permissions", label: "settings.permissions.title", icon: "shield" },
        { value: "privacy", label: "settings.network.privacy", icon: "glasses" },
      ],
    },
    {
      label: "settings.group.other",
      items: [
        { value: "servers", label: "status.popover.tab.servers", icon: "server" },
        { value: "experiments", label: "settings.experiments", icon: "branch" },
        { value: "about", label: "settings.about.title", icon: "help" },
      ],
    },
  ] as const

  const showProviders = () => {
    if (props.embedded) {
      dialog.close()
      setTab("providers")
      return
    }
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  return (
    <Dynamic
      component={props.embedded ? "section" : Dialog}
      size="x-large"
      variant="settings"
      class={props.embedded ? "settings-v2-page" : "settings-v2-dialog"}
    >
      <Show
        when={props.embedded}
        fallback={
          <DialogHeader closeLabel={language.t("common.close")}>
            <DialogTitle>{language.t("sidebar.settings")}</DialogTitle>
          </DialogHeader>
        }
      >
        <header class="flex h-[50px] shrink-0 items-center justify-between border-b border-v2-border-border-muted px-6">
          <span class="text-sm font-medium">{language.t("sidebar.settings")}</span>
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-lg hover:bg-v2-background-bg-layer-02"
            onClick={props.onClose}
            aria-label={language.t("common.close")}
          >
            ×
          </button>
        </header>
      </Show>
      <Show when={props.serverLabel}>
        <p data-slot="settings-server" class="px-6 py-2 text-sm">
          {language.t("settings.targetServer", { server: props.serverLabel ?? "" })}
        </p>
      </Show>
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex h-full w-full flex-col gap-4 overflow-auto">
            <input
              type="search"
              class="h-8 w-full shrink-0 rounded-lg border border-v2-border-border-muted bg-transparent px-2 text-xs outline-none focus:border-v2-border-border-focus"
              aria-label={language.t("settings.search")}
              placeholder={language.t("settings.search")}
              value={search.value}
              onInput={(event) => setSearch("value", event.currentTarget.value)}
            />
            <For each={groups}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <TabsV2.SectionTitle>{language.t(group.label)}</TabsV2.SectionTitle>
                  <For
                    each={group.items.filter(
                      (item) =>
                        (item.value !== "servers" || platform.remoteServers !== false) &&
                        language.t(item.label).toLocaleLowerCase().includes(search.value.toLocaleLowerCase()),
                    )}
                  >
                    {(item) => (
                      <TabsV2.Trigger value={item.value}>
                        <Icon name={item.icon} />
                        {language.t(item.label)}
                      </TabsV2.Trigger>
                    )}
                  </For>
                </div>
              )}
            </For>
            <div class="settings-v2-nav-footer mt-auto">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 serverKey={props.serverKey} sessionID={props.sessionID} section="general" />
        </TabsV2.Content>
        <TabsV2.Content value="permissions" class="settings-v2-panel">
          <SettingsGeneralV2 serverKey={props.serverKey} sessionID={props.sessionID} section="permissions" />
        </TabsV2.Content>
        <TabsV2.Content value="appearance" class="settings-v2-panel">
          <SettingsGeneralV2 serverKey={props.serverKey} sessionID={props.sessionID} section="appearance" />
        </TabsV2.Content>
        <TabsV2.Content value="privacy" class="settings-v2-panel">
          <SettingsGeneralV2 serverKey={props.serverKey} sessionID={props.sessionID} section="privacy" />
        </TabsV2.Content>
        <TabsV2.Content value="experiments" class="settings-v2-panel">
          <SettingsGeneralV2 serverKey={props.serverKey} sessionID={props.sessionID} section="experiments" />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="usage" class="settings-v2-panel">
          <UsageDashboard />
        </TabsV2.Content>
        <Show when={platform.remoteServers !== false}>
          <TabsV2.Content value="servers" class="settings-v2-panel">
            <SettingsServersV2 />
          </TabsV2.Content>
        </Show>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 onBack={showProviders} />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="about" class="settings-v2-panel">
          <SettingsAbout />
        </TabsV2.Content>
      </TabsV2>
    </Dynamic>
  )
}
