import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { TextInputV2 } from "@zaovra-ai/ui/v2/text-input-v2"
import { type Component, For, Show, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type Layer = "project" | "user"

// Everything Zaovra keeps from earlier conversations is listed here and nothing else is used:
// what the user cannot see, they cannot correct.
export const SettingsMemoryV2: Component<{ directory?: string; sessionID?: string }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  // Opened from a conversation, the project is that conversation's, as in the other settings pages.
  const directory = createMemo(() =>
    props.sessionID ? serverSync().session.lineage.peek(props.sessionID)?.session.directory : props.directory,
  )
  const memory = () => serverSdk().client.v2.memory
  const location = () => (directory() ? { directory: directory()! } : undefined)
  const read = (layer: Layer) =>
    memory()
      .list({ location: location(), layer }, { throwOnError: true })
      .then((result) => result.data.data)
  const [project, projectActions] = createResource(
    () => (directory() ? [serverSdk().scope, directory()] : undefined),
    () => read("project"),
  )
  const [user, userActions] = createResource(
    () => serverSdk().scope,
    () => read("user"),
  )
  const [state, setState] = createStore({
    editing: undefined as string | undefined,
    text: "",
    draft: { project: "", user: "" },
    confirming: undefined as Layer | undefined,
  })
  const reload = (layer: Layer) => (layer === "project" ? projectActions.refetch() : userActions.refetch())

  const save = async (layer: Layer, id: string) => {
    if (!state.text.trim()) return
    await memory().update({ id, text: state.text }, { throwOnError: true })
    setState("editing", undefined)
    await reload(layer)
  }
  const adopt = async (layer: Layer, id: string) => {
    await memory().update({ id, status: "verified" }, { throwOnError: true })
    await reload(layer)
  }
  const remove = async (layer: Layer, id: string) => {
    await memory().remove({ id }, { throwOnError: true })
    await reload(layer)
  }
  const add = async (layer: Layer) => {
    const text = state.draft[layer].trim()
    if (!text) return
    await memory().create({ location: location(), layer, kind: "preference", text }, { throwOnError: true })
    setState("draft", layer, "")
    await reload(layer)
  }
  const clear = async (layer: Layer) => {
    await memory().clear({ location: location(), layer }, { throwOnError: true })
    setState("confirming", undefined)
    await reload(layer)
  }

  const section = (layer: Layer, notes: () => Awaited<ReturnType<typeof read>> | undefined) => (
    <section data-slot="settings-memory-section" data-layer={layer} class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-medium">{language.t(`settings.memory.${layer}.title`)}</h3>
          <p class="text-xs text-v2-text-text-muted">{language.t(`settings.memory.${layer}.description`)}</p>
        </div>
        <Show when={(notes()?.length ?? 0) > 0}>
          <Show
            when={state.confirming === layer}
            fallback={
              <ButtonV2 variant="neutral" onClick={() => setState("confirming", layer)}>
                {language.t("settings.memory.clear")}
              </ButtonV2>
            }
          >
            <div class="flex shrink-0 items-center gap-2">
              <span class="text-xs text-v2-text-text-muted">{language.t("settings.memory.clear.confirm")}</span>
              <ButtonV2 variant="neutral" onClick={() => void clear(layer)}>
                {language.t("settings.memory.clear")}
              </ButtonV2>
              <ButtonV2 variant="neutral" onClick={() => setState("confirming", undefined)}>
                {language.t("common.cancel")}
              </ButtonV2>
            </div>
          </Show>
        </Show>
      </div>
      <SettingsListV2>
        <Show
          when={(notes()?.length ?? 0) > 0}
          fallback={<p class="text-xs text-v2-text-text-muted">{language.t("settings.memory.empty")}</p>}
        >
          <For each={notes()}>
            {(note) => (
              <div data-slot="settings-memory-note" class="settings-v2-servers-row">
                <Show
                  when={state.editing === note.id}
                  fallback={
                    <>
                      <div class="flex min-w-0 flex-col gap-1">
                        <span class="break-words text-sm">{note.text}</span>
                        <span class="text-xs text-v2-text-text-muted">
                          {language.t(`settings.memory.kind.${note.kind}`)}
                          {" · "}
                          {language.t(`settings.memory.origin.${note.origin}`)}
                          {" · "}
                          {language.t(`settings.memory.status.${note.status}`)}
                          {" · "}
                          {new Date(note.time.observed).toLocaleDateString()}
                        </span>
                      </div>
                      <div class="settings-v2-servers-actions">
                        <Show when={note.status !== "verified"}>
                          <ButtonV2 variant="neutral" onClick={() => void adopt(layer, note.id)}>
                            {language.t("settings.memory.use")}
                          </ButtonV2>
                        </Show>
                        <ButtonV2 variant="neutral" onClick={() => setState({ editing: note.id, text: note.text })}>
                          {language.t("common.edit")}
                        </ButtonV2>
                        <ButtonV2 variant="neutral" onClick={() => void remove(layer, note.id)}>
                          {language.t("common.delete")}
                        </ButtonV2>
                      </div>
                    </>
                  }
                >
                  <TextInputV2
                    appearance="base"
                    class="min-w-0 flex-1"
                    value={state.text}
                    aria-label={language.t("common.edit")}
                    onInput={(event) => setState("text", event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void save(layer, note.id)
                      if (event.key === "Escape") setState("editing", undefined)
                    }}
                  />
                  <div class="settings-v2-servers-actions">
                    <ButtonV2 variant="neutral" onClick={() => void save(layer, note.id)}>
                      {language.t("common.save")}
                    </ButtonV2>
                    <ButtonV2 variant="neutral" onClick={() => setState("editing", undefined)}>
                      {language.t("common.cancel")}
                    </ButtonV2>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </SettingsListV2>
      <div class="flex items-center gap-2">
        <TextInputV2
          appearance="base"
          class="min-w-0 flex-1"
          value={state.draft[layer]}
          placeholder={language.t(`settings.memory.${layer}.add`)}
          aria-label={language.t(`settings.memory.${layer}.add`)}
          onInput={(event) => setState("draft", layer, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add(layer)
          }}
        />
        <ButtonV2 variant="neutral" disabled={!state.draft[layer].trim()} onClick={() => void add(layer)}>
          {language.t("settings.memory.add")}
        </ButtonV2>
      </div>
    </section>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.memory.title")}</h2>
      </div>
      <div class="settings-v2-tab-body flex flex-col gap-8">
        <p class="text-xs text-v2-text-text-muted">{language.t("settings.memory.description")}</p>
        <Show when={directory()}>{section("project", project)}</Show>
        {section("user", user)}
      </div>
    </>
  )
}
