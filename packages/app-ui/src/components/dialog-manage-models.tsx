import { Dialog } from "@zaovra-ai/ui/dialog"
import { List } from "@zaovra-ai/ui/list"
import { Button } from "@zaovra-ai/ui/button"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { Dialog as DialogV2, DialogBody, DialogHeader, DialogTitleGroup } from "@zaovra-ai/ui/v2/dialog-v2"
import { Icon as IconV2 } from "@zaovra-ai/ui/v2/icon"
import { IconButtonV2 } from "@zaovra-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@zaovra-ai/ui/v2/text-input-v2"
import { ProviderIcon } from "@zaovra-ai/ui/provider-icon"
import { useFilteredList } from "@zaovra-ai/ui/hooks"
import { For, Show, type Component } from "solid-js"
import { useLocal } from "@/context/local"
import { popularProviders } from "@/hooks/use-providers"
import { useLanguage } from "@/context/language"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { decode64 } from "@/utils/base64"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsRowV2 } from "./settings-v2/parts/row"
import "./settings-v2/settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useLocal>["model"]["list"]>[number]

export const DialogManageModels: Component = () => {
  const local = useLocal()
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => decode64(local.slug())

  const handleConnectProvider = () => {
    void dialog.show(() => <DialogConnectProvider directory={directory} />)
  }
  const providerRank = (id: string) => popularProviders.indexOf(id)
  return (
    <Dialog
      title={language.t("dialog.model.manage")}
      description={language.t("dialog.model.manage.description")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={handleConnectProvider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.model.empty")}
        key={(x) => `${x?.provider?.id}:${x?.id}`}
        items={local.model.list()}
        filterKeys={["provider.name", "name", "id"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => x.provider.id}
        groupHeader={(group) => {
          const provider = group.items[0].provider
          return (
            <>
              <span>{provider.name}</span>
            </>
          )
        }}
        sortGroupsBy={(a, b) => {
          const aRank = providerRank(a.items[0].provider.id)
          const bRank = providerRank(b.items[0].provider.id)
          const aPopular = aRank >= 0
          const bPopular = bRank >= 0
          if (aPopular && !bPopular) return -1
          if (!aPopular && bPopular) return 1
          return aRank - bRank
        }}
        onSelect={(x) => {
          if (!x) return
          const key = { modelID: x.id, providerID: x.provider.id }
          local.model.set(key, { recent: true })
          dialog.close()
        }}
      >
        {(i) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <span>{i.name}</span>
            <div onClick={(e) => e.stopPropagation()}>
              <input
                type="radio"
                name="manage-model"
                aria-label={i.name}
                checked={
                  local.model.current()?.provider.id === i.provider.id && local.model.current()?.baseModelID === i.id
                }
                onChange={() => {
                  local.model.set({ providerID: i.provider.id, modelID: i.id }, { recent: true })
                  dialog.close()
                }}
              />
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}

export const DialogManageModelsV2: Component = () => {
  const local = useLocal()
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => decode64(local.slug())

  const handleConnectProvider = () => {
    void dialog.show(() => <DialogConnectProvider directory={directory} />)
  }
  const list = useFilteredList<ModelItem>({
    items: () => local.model.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aRank = popularProviders.indexOf(a.category)
      const bRank = popularProviders.indexOf(b.category)
      const aPopular = aRank >= 0
      const bPopular = bRank >= 0
      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      return aRank - bRank
    },
  })

  return (
    <DialogV2 size="large" variant="settings" class="settings-v2-manage-models-dialog">
      <DialogHeader hideClose={true} closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={language.t("dialog.model.manage")}
          description={language.t("dialog.model.manage.description")}
        />
        <ButtonV2 variant="neutral" icon="plus" onClick={handleConnectProvider}>
          {language.t("command.provider.connect")}
        </ButtonV2>
      </DialogHeader>
      <DialogBody class="flex min-h-0 flex-1 flex-col">
        <div class="px-4 pt-px pb-3">
          <div class="relative">
            <TextInputV2
              type="search"
              appearance="base"
              class="!w-full self-stretch"
              value={list.filter()}
              onInput={(event) => list.onInput(event.currentTarget.value)}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              autofocus
              aria-label={language.t("dialog.model.search.placeholder")}
            />
            <Show when={list.filter()}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => list.clear()}
                aria-label={language.t("common.clear")}
              />
            </Show>
          </div>
        </div>
        <div data-slot="manage-models-scroll" class="relative min-h-0 flex-1">
          <div class="settings-v2-panel settings-v2-models h-full px-4 pt-4 pb-4">
            <Show
              when={!list.grouped.loading}
              fallback={
                <div class="settings-v2-models-status">
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </div>
              }
            >
              <Show
                when={list.flat().length > 0}
                fallback={
                  <div class="settings-v2-models-status">
                    <span>{language.t("dialog.model.empty")}</span>
                    <Show when={list.filter()}>
                      <span class="settings-v2-models-status-filter">&quot;{list.filter()}&quot;</span>
                    </Show>
                  </div>
                }
              >
                <For each={list.grouped.latest}>
                  {(group) => (
                    <div class="settings-v2-section" data-component="settings-models-provider">
                      <div class="settings-v2-models-group-header justify-between">
                        <div class="flex min-w-0 items-center gap-2">
                          <ProviderIcon id={group.category} width={16} height={16} class="ml-4 shrink-0" />
                          <h3 class="settings-v2-section-title">{group.items[0].provider.name}</h3>
                        </div>
                        <div></div>
                      </div>
                      <SettingsListV2>
                        <For each={group.items}>
                          {(item) => (
                            <SettingsRowV2 title={item.name} description="">
                              <div>
                                <input
                                  type="radio"
                                  name="manage-model"
                                  aria-label={item.name}
                                  checked={
                                    local.model.current()?.provider.id === item.provider.id &&
                                    local.model.current()?.baseModelID === item.id
                                  }
                                  onChange={() => {
                                    local.model.set(
                                      { providerID: item.provider.id, modelID: item.id },
                                      { recent: true },
                                    )
                                    dialog.close()
                                  }}
                                />
                              </div>
                            </SettingsRowV2>
                          )}
                        </For>
                      </SettingsListV2>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
