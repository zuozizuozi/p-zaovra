import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { TextInputV2 } from "@zaovra-ai/ui/v2/text-input-v2"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@zaovra-ai/core/util/encode"
import { For, Show, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"

export function MemorySourceLink(props: { sessionID: string; seq?: number }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const target = sdk()
  const navigate = useNavigate()
  const dialog = useDialog()
  const [state, setState] = createStore({ busy: false, error: false })
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const open = async () => {
    if (state.busy) return
    setState({ busy: true, error: false })
    await target.client.v2.session.get({ sessionID: props.sessionID }, { throwOnError: true }).then(
      (result) => {
        if (disposed || sdk().scope !== target.scope) return
        setState("busy", false)
        dialog.close()
        navigate(`/${base64Encode(result.data.data.location.directory)}/session/${result.data.data.id}`)
      },
      () => {
        if (!disposed) setState({ busy: false, error: true })
      },
    )
  }
  return (
    <span class="flex flex-wrap items-center gap-2 text-xs">
      <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void open()}>
        {language.t("settings.memory.source")} {props.seq === undefined ? "" : `#${props.seq}`}
      </ButtonV2>
      <Show when={state.error}>
        <span role="alert">{language.t("settings.memory.source.failed")}</span>
      </Show>
    </span>
  )
}

// The parent keys this component by server and project. Requests always use the
// captured client/location, and late responses cannot update a replacement panel.
export function MemoryPagesPanel(props: { directory?: string; refresh: number; projectFrozen: boolean }) {
  const language = useLanguage()
  const sdk = useServerSDK()()
  const location = props.directory ? { directory: props.directory } : undefined
  const [state, setState] = createStore({
    layer: (props.directory ? "project" : "user") as "project" | "user",
    editing: "",
    summary: "",
    body: "",
    expected: "",
    deleting: "",
    busy: false,
    error: false,
  })
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const [pages, actions] = createResource(
    () => [state.layer, props.refresh] as const,
    async ([layer]) => (await sdk.client.v2.memory.listPages({ location, layer }, { throwOnError: true })).data.data,
  )
  const frozen = () => state.layer === "project" && props.projectFrozen
  const change = async (id: string, remove: boolean) => {
    if (state.busy || frozen()) return
    const layer = state.layer
    setState({ busy: true, error: false })
    const request = remove
      ? sdk.client.v2.memory.removePage({ location, layer, id }, { throwOnError: true })
      : sdk.client.v2.memory.updatePage(
          { location, layer, id, summary: state.summary, body: state.body, expected: state.expected },
          { throwOnError: true },
        )
    await request.then(
      async () => {
        if (disposed) return
        setState({ busy: false, editing: "", deleting: "" })
        await actions.refetch()
      },
      () => {
        if (!disposed) setState({ busy: false, error: true })
      },
    )
  }
  return (
    <section data-slot="memory-pages" class="flex flex-col gap-3">
      <h3 class="text-sm font-medium">{language.t("settings.memory.pages.title")}</h3>
      <p class="text-xs text-v2-text-text-muted">{language.t("settings.memory.pages.description")}</p>
      <div class="flex items-center gap-2">
        <select
          aria-label={language.t("settings.memory.pages.layer")}
          value={state.layer}
          disabled={state.busy}
          onChange={(event) =>
            setState({
              layer: event.currentTarget.value === "user" ? "user" : "project",
              editing: "",
              deleting: "",
              error: false,
            })
          }
        >
          <Show when={props.directory}>
            <option value="project">{language.t("settings.memory.project.title")}</option>
          </Show>
          <option value="user">{language.t("settings.memory.user.title")}</option>
        </select>
        <ButtonV2 variant="neutral" disabled={state.busy || pages.loading} onClick={() => void actions.refetch()}>
          {language.t("settings.memory.pages.refresh")}
        </ButtonV2>
      </div>
      <Show when={pages.error || state.error}>
        <p role="alert" class="text-xs">
          {language.t("settings.memory.pages.failed")}
        </p>
      </Show>
      <Show when={!pages.loading && !pages.error && pages()?.length === 0}>
        <p class="text-xs">{language.t("settings.memory.pages.empty")}</p>
      </Show>
      <fieldset disabled={state.busy || frozen() || pages.loading} class="flex flex-col gap-3">
        <For each={!pages.loading && !pages.error ? pages() : []}>
          {(page) => (
            <details data-slot="memory-page" class="rounded-lg border border-v2-border-base p-3">
              <summary class="cursor-pointer text-sm font-medium">
                {page.title} · {language.t(`settings.memory.pages.${page.status}`)}
              </summary>
              <div class="flex flex-col gap-3 pt-3">
                <Show when={page.origin === "user"}>
                  <p class="text-xs">{language.t("settings.memory.pages.protected")}</p>
                </Show>
                <Show
                  when={state.editing === page.id}
                  fallback={
                    <>
                      <p class="break-words text-sm">{page.summary}</p>
                      <p class="whitespace-pre-wrap break-words text-sm">{page.body}</p>
                      <ButtonV2
                        variant="neutral"
                        onClick={() =>
                          setState({
                            editing: page.id,
                            expected: page.revision,
                            summary: page.summary,
                            body: page.body,
                            deleting: "",
                            error: false,
                          })
                        }
                      >
                        {language.t("common.edit")}
                      </ButtonV2>
                    </>
                  }
                >
                  <TextInputV2
                    appearance="base"
                    aria-label={language.t("settings.memory.pages.summary")}
                    value={state.summary}
                    onInput={(event) => setState("summary", event.currentTarget.value)}
                  />
                  <textarea
                    aria-label={language.t("settings.memory.pages.body")}
                    rows={8}
                    class="w-full rounded border p-2 text-sm"
                    value={state.body}
                    onInput={(event) => setState("body", event.currentTarget.value)}
                  />
                  <div class="flex gap-2">
                    <ButtonV2
                      variant="neutral"
                      disabled={!state.summary.trim() || !state.body.trim()}
                      onClick={() => void change(page.id, false)}
                    >
                      {language.t("common.save")}
                    </ButtonV2>
                    <ButtonV2 variant="neutral" onClick={() => setState("editing", "")}>
                      {language.t("common.cancel")}
                    </ButtonV2>
                  </div>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <For each={page.sources}>
                    {(source) => (
                      <Show when={source.sessionID} keyed>
                        {(sessionID) => <MemorySourceLink sessionID={sessionID} seq={source.seq} />}
                      </Show>
                    )}
                  </For>
                </div>
                <Show
                  when={state.deleting === page.id}
                  fallback={
                    <ButtonV2 variant="neutral" onClick={() => setState("deleting", page.id)}>
                      {language.t("common.delete")}
                    </ButtonV2>
                  }
                >
                  <p class="text-xs">{language.t("settings.memory.pages.delete")}</p>
                  <div class="flex gap-2">
                    <ButtonV2 variant="neutral" onClick={() => void change(page.id, true)}>
                      {language.t("common.delete")}
                    </ButtonV2>
                    <ButtonV2 variant="neutral" onClick={() => setState("deleting", "")}>
                      {language.t("common.cancel")}
                    </ButtonV2>
                  </div>
                </Show>
              </div>
            </details>
          )}
        </For>
      </fieldset>
    </section>
  )
}
