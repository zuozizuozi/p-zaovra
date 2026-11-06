import { useFilteredList } from "@zaovra-ai/ui/hooks"
import { Tag } from "@zaovra-ai/ui/v2/badge-v2"
import { Icon as IconV2 } from "@zaovra-ai/ui/v2/icon"
import { IconButtonV2 } from "@zaovra-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@zaovra-ai/ui/v2/text-input-v2"
import { type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { providerModelTypes, type ProviderModelType } from "@/provider-discovery"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

export const SettingsModelsV2: Component = () => {
  const language = useLanguage()
  const models = useModels()

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
        <div class="settings-v2-tab-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={list.filter()}
            onInput={(event) => list.onInput(event.currentTarget.value)}
            placeholder={language.t("dialog.model.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
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
            />
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
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
            <SettingsListV2>
              <For each={list.flat()}>
                {(item) => (
                  <SettingsRowV2
                    title={
                      <span class="flex items-center gap-2">
                        <span>{item.name}</span>
                        <Tag>{item.provider.name}</Tag>
                      </span>
                    }
                    description={`${item.id} · ${language.t(`provider.custom.modelType.${models.type({ providerID: item.provider.id, modelID: item.id })}`)}`}
                  >
                    <select
                      class="max-w-44 rounded border border-v2-border-border-base bg-transparent p-1 text-xs"
                      aria-label={`${item.name} · ${language.t("provider.custom.modelType.label")}`}
                      value={models.typeOverride({ providerID: item.provider.id, modelID: item.id }) ?? "auto"}
                      onChange={(event) =>
                        models.setType(
                          { providerID: item.provider.id, modelID: item.id },
                          event.currentTarget.value === "auto"
                            ? undefined
                            : (event.currentTarget.value as ProviderModelType),
                        )
                      }
                    >
                      <option value="auto">{language.t("provider.custom.modelType.auto")}</option>
                      <For each={providerModelTypes}>
                        {(type) => <option value={type}>{language.t(`provider.custom.modelType.${type}`)}</option>}
                      </For>
                    </select>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </Show>
        </Show>
      </div>
    </>
  )
}
