import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { Switch } from "@zaovra-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@zaovra-ai/ui/v2/text-input-v2"
import { type Component, For, Show, createEffect, createMemo, createResource, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"
import { MemoryRecoveryPanel } from "./memory-recovery"
import { MemoryTidyPanel } from "./memory-tidy"
import { MemoryPagesPanel, MemorySourceLink } from "./memory-pages"

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
  const [recovery, recoveryActions] = createResource(
    () => (directory() ? ([serverSdk().scope, directory()] as const) : undefined),
    async () => (await memory().recovery({ location: location() }, { throwOnError: true })).data.data,
  )
  const frozen = () =>
    !!directory() && (recovery.loading || !!recovery.error || !recovery() || recovery()?.frozen === true)
  const resolveRecovery = async (decision: "restore" | "blank", ids: string[]) => {
    const target = directory()
    const server = serverSdk().scope
    const result = await memory().resolveRecovery(
      { location: location(), memoryRecoveryChoice: { decision, ids } },
      { throwOnError: true },
    )
    if (target === directory() && server === serverSdk().scope) {
      recoveryActions.mutate(result.data.data)
      await projectActions.refetch()
    }
    return result.data.accepted
  }
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
    confirming: undefined as { server: string; directory?: string; layer: Layer } | undefined,
    noteBusy: false,
    noteError: undefined as Layer | undefined,
    pagesRevision: 0,
    saving: false,
    configError: false,
  })
  const pendingConfig = { revision: 0 }
  const pendingNotes = { revision: 0 }
  createEffect(
    on(
      () => [serverSdk().scope, directory()] as const,
      () => {
        pendingNotes.revision++
        setState({
          editing: undefined,
          text: "",
          draft: { project: "", user: "" },
          confirming: undefined,
          noteBusy: false,
          noteError: undefined,
        })
      },
    ),
  )
  onCleanup(() => pendingNotes.revision++)
  createEffect(
    on(
      () => serverSdk().scope,
      () => {
        pendingConfig.revision++
        setState({ saving: false, configError: false })
      },
    ),
  )
  onCleanup(() => pendingConfig.revision++)
  const updateMemory = async (patch: NonNullable<ReturnType<typeof serverSync>["data"]["config"]["memory"]>) => {
    if (state.saving) return
    const revision = ++pendingConfig.revision
    const target = serverSdk().scope
    const sync = serverSync()
    const previous = sync.data.config.memory
    setState({ saving: true, configError: false })
    try {
      await sync.updateConfig({
        memory: {
          ...previous,
          ...patch,
          ...(patch.index ? { index: { ...previous?.index, ...patch.index } } : {}),
        },
      })
    } catch {
      if (revision === pendingConfig.revision && target === serverSdk().scope) setState("configError", true)
    } finally {
      if (revision === pendingConfig.revision && target === serverSdk().scope) setState("saving", false)
    }
  }
  const reload = (layer: Layer) => (layer === "project" ? projectActions.refetch() : userActions.refetch())

  const confirmed = (layer: Layer) =>
    state.confirming?.layer === layer &&
    state.confirming.server === serverSdk().scope &&
    state.confirming.directory === directory()
  const changeNote = async (layer: Layer, action: "add" | "save" | "adopt" | "remove" | "clear", id?: string) => {
    if (
      state.noteBusy ||
      (layer === "project" ? frozen() || project.loading || !!project.error : user.loading || !!user.error)
    )
      return
    if (id && !(layer === "project" ? project() : user())?.some((note) => note.id === id)) return
    if (action === "save" && state.editing !== id) return
    if (action === "clear" && !confirmed(layer)) return
    const text = (action === "add" ? state.draft[layer] : state.text).trim()
    if ((action === "add" || action === "save") && !text) return
    const client = memory()
    const server = serverSdk().scope
    const target = directory()
    const revision = ++pendingNotes.revision
    const current = () => pendingNotes.revision === revision && serverSdk().scope === server && directory() === target
    setState({ noteBusy: true, noteError: undefined })
    try {
      const accepted = await (action === "add"
        ? client
            .create(
              { location: target ? { directory: target } : undefined, layer, kind: "preference", text },
              { throwOnError: true },
            )
            .then((result) => result.data.data !== null)
        : action === "save" || action === "adopt"
          ? client
              .update(
                { id: id!, ...(action === "save" ? { text } : { status: "verified" as const }) },
                { throwOnError: true },
              )
              .then((result) => result.data.data !== null)
          : action === "remove"
            ? client.remove({ id: id! }, { throwOnError: true }).then(() => true)
            : client
                .clear({ location: target ? { directory: target } : undefined, layer }, { throwOnError: true })
                .then(() => true))
      if (!current()) return
      if (!accepted) {
        setState("noteError", layer)
        return
      }
      if (action === "add") setState("draft", layer, "")
      if (action === "save") setState("editing", undefined)
      if (action === "clear") {
        setState("confirming", undefined)
        setState("pagesRevision", (value) => value + 1)
      }
      await Promise.resolve(reload(layer)).catch(() => undefined)
    } catch {
      if (current()) setState("noteError", layer)
    } finally {
      if (current()) setState("noteBusy", false)
    }
  }
  const tidyTarget = createMemo(() =>
    directory() ? { directory: directory()!, server: serverSdk().scope } : undefined,
  )
  const pagesTarget = createMemo(() => ({ directory: directory(), server: serverSdk().scope }))

  const section = (layer: Layer, notes: typeof project) => (
    <section data-slot="settings-memory-section" data-layer={layer} class="flex flex-col gap-3">
      <fieldset disabled={state.noteBusy || notes.loading || !!notes.error} class="contents">
        <div class="flex items-center justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h3 class="text-sm font-medium">{language.t(`settings.memory.${layer}.title`)}</h3>
            <p class="text-xs text-v2-text-text-muted">{language.t(`settings.memory.${layer}.description`)}</p>
          </div>
          <Show when={!notes.error && (notes()?.length ?? 0) > 0}>
            <Show
              when={confirmed(layer)}
              fallback={
                <ButtonV2
                  variant="neutral"
                  onClick={() => setState("confirming", { server: serverSdk().scope, directory: directory(), layer })}
                >
                  {language.t("settings.memory.clear")}
                </ButtonV2>
              }
            >
              <div class="flex shrink-0 items-center gap-2">
                <span class="text-xs text-v2-text-text-muted">{language.t("settings.memory.clear.confirm")}</span>
                <ButtonV2 variant="neutral" onClick={() => void changeNote(layer, "clear")}>
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
            when={!notes.error && (notes()?.length ?? 0) > 0}
            fallback={
              <Show when={!notes.error && !notes.loading}>
                <p class="text-xs text-v2-text-text-muted">{language.t("settings.memory.empty")}</p>
              </Show>
            }
          >
            <For each={notes.error ? [] : notes()}>
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
                          <Show when={fileState(note.files)} keyed>
                            {(status) => (
                              <span class="text-xs text-v2-text-text-muted">
                                {language.t(`settings.memory.files.${status}`)}
                              </span>
                            )}
                          </Show>
                          <Show when={note.sessionID} keyed>
                            {(sessionID) => <MemorySourceLink sessionID={sessionID} seq={note.seq} />}
                          </Show>
                        </div>
                        <div class="settings-v2-servers-actions">
                          <Show when={note.status !== "verified"}>
                            <ButtonV2 variant="neutral" onClick={() => void changeNote(layer, "adopt", note.id)}>
                              {language.t("settings.memory.use")}
                            </ButtonV2>
                          </Show>
                          <ButtonV2 variant="neutral" onClick={() => setState({ editing: note.id, text: note.text })}>
                            {language.t("common.edit")}
                          </ButtonV2>
                          <ButtonV2 variant="neutral" onClick={() => void changeNote(layer, "remove", note.id)}>
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
                        if (event.key === "Enter") void changeNote(layer, "save", note.id)
                        if (event.key === "Escape") setState("editing", undefined)
                      }}
                    />
                    <div class="settings-v2-servers-actions">
                      <ButtonV2 variant="neutral" onClick={() => void changeNote(layer, "save", note.id)}>
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
              if (event.key === "Enter") void changeNote(layer, "add")
            }}
          />
          <ButtonV2
            variant="neutral"
            disabled={!state.draft[layer].trim()}
            onClick={() => void changeNote(layer, "add")}
          >
            {language.t("settings.memory.add")}
          </ButtonV2>
        </div>
      </fieldset>
      <Show when={notes.error}>
        <p role="alert">{language.t("settings.memory.read.failed")}</p>
        <ButtonV2
          variant="neutral"
          data-action="reload-memory-notes"
          disabled={notes.loading}
          onClick={() => void Promise.resolve(reload(layer)).catch(() => undefined)}
        >
          {language.t("settings.memory.reload")}
        </ButtonV2>
      </Show>
      <Show when={state.noteError === layer}>
        <p role="alert">{language.t("settings.memory.note.failed")}</p>
      </Show>
    </section>
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.memory.title")}</h2>
      </div>
      <div class="settings-v2-tab-body flex flex-col gap-8">
        <p class="text-xs text-v2-text-text-muted">{language.t("settings.memory.description")}</p>
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("settings.memory.enabled.title")}
            description={language.t("settings.memory.enabled.description")}
          >
            <div data-action="settings-memory-enabled">
              <Switch
                hideLabel
                checked={serverSync().data.config.memory?.enabled === true}
                disabled={state.saving}
                onChange={(enabled) => void updateMemory({ enabled })}
              >
                {language.t("settings.memory.enabled.title")}
              </Switch>
            </div>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.memory.index.title")}
            description={language.t("settings.memory.index.description")}
          >
            <div data-action="settings-memory-index">
              <Switch
                hideLabel
                checked={serverSync().data.config.memory?.index?.enabled !== false}
                disabled={state.saving || serverSync().data.config.memory?.enabled !== true}
                onChange={(enabled) => void updateMemory({ index: { enabled } })}
              >
                {language.t("settings.memory.index.title")}
              </Switch>
            </div>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.memory.search.title")}
            description={language.t("settings.memory.search.description")}
          >
            <div data-action="settings-memory-search">
              <Switch
                hideLabel
                checked={serverSync().data.config.memory?.taskSearch !== false}
                disabled={state.saving || serverSync().data.config.memory?.enabled !== true}
                onChange={(taskSearch) => void updateMemory({ taskSearch })}
              >
                {language.t("settings.memory.search.title")}
              </Switch>
            </div>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("settings.memory.index.limits")}
            description={language.t("settings.memory.index.limits.description")}
          >
            <fieldset class="flex gap-3" disabled={state.saving || serverSync().data.config.memory?.enabled !== true}>
              <label class="text-xs">
                {language.t("settings.memory.index.lines")}
                <TextInputV2
                  type="number"
                  min="8"
                  max="200"
                  step="1"
                  aria-label={language.t("settings.memory.index.lines")}
                  value={serverSync().data.config.memory?.index?.maxLines ?? 60}
                  onChange={(event) => {
                    if (event.currentTarget.reportValidity() && event.currentTarget.value !== "")
                      void updateMemory({ index: { maxLines: Number(event.currentTarget.value) } })
                  }}
                />
              </label>
              <label class="text-xs">
                {language.t("settings.memory.index.bytes")}
                <TextInputV2
                  type="number"
                  min="1024"
                  max="25600"
                  step="1"
                  aria-label={language.t("settings.memory.index.bytes")}
                  value={serverSync().data.config.memory?.index?.maxBytes ?? 4096}
                  onChange={(event) => {
                    if (event.currentTarget.reportValidity() && event.currentTarget.value !== "")
                      void updateMemory({ index: { maxBytes: Number(event.currentTarget.value) } })
                  }}
                />
              </label>
            </fieldset>
          </SettingsRowV2>
        </SettingsListV2>
        <Show when={state.configError}>
          <p role="alert">{language.t("settings.memory.config.failed")}</p>
        </Show>
        <Show when={directory()}>
          <Show when={recovery.error}>
            <p role="alert">{language.t("settings.memory.recovery.failed")}</p>
            <ButtonV2 variant="neutral" onClick={() => void recoveryActions.refetch()}>
              {language.t("settings.memory.recovery.retry")}
            </ButtonV2>
          </Show>
          <Show when={!recovery.loading && !recovery.error && recovery()?.state !== "none" && recovery()} keyed>
            {(data) => <MemoryRecoveryPanel data={data} resolve={resolveRecovery} />}
          </Show>
          <fieldset data-slot="memory-project" disabled={frozen()}>
            {section("project", project)}
          </fieldset>
        </Show>
        <Show when={tidyTarget()} keyed>
          {(target) => (
            <MemoryTidyPanel
              directory={target.directory}
              disabled={serverSync().data.config.memory?.enabled !== true}
              projectFrozen={frozen() || !!recovery()?.automaticFrozen}
            />
          )}
        </Show>
        {section("user", user)}
        <Show when={pagesTarget()} keyed>
          {(target) => (
            <MemoryPagesPanel directory={target.directory} refresh={state.pagesRevision} projectFrozen={frozen()} />
          )}
        </Show>
      </div>
    </>
  )
}

function fileState(value: unknown) {
  if (value === undefined) return
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("state" in value))
    return "unknown"
  return value.state === "current" || value.state === "changed" || value.state === "missing" ? value.state : "unknown"
}
