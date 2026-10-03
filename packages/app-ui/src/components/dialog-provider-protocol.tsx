import { For, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@zaovra-ai/ui/button"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { protocolChoice, protocolPatch, type ProtocolChoice } from "./provider-protocol"

export function DialogProviderProtocol(props: { providerID: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const sync = useServerSync()
  const configured = sync().data.config.provider?.[props.providerID]
  if (!configured || !protocolChoice(configured.npm)) return null
  const initial = structuredClone(unwrap(configured))
  const [state, setState] = createStore({
    choice: protocolChoice(initial.npm)!,
    models: Object.fromEntries(
      Object.entries(initial.models ?? {}).map(([id, model]) => [id, protocolChoice(model.provider?.npm) ?? ""]),
    ),
    pending: false,
    error: "",
  })
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.pending) return
    setState({ pending: true, error: "" })
    try {
      // Read the latest configuration, preserving unrelated edits and credentials.
      const current = sync().data.config.provider?.[props.providerID]
      if (
        !current ||
        current.npm !== initial.npm ||
        Object.entries(initial.models ?? {}).some(
          ([id, model]) => current.models?.[id]?.provider?.npm !== model.provider?.npm,
        )
      )
        throw new Error(language.t("provider.protocol.changed"))
      await sync().updateConfig({
        provider: { [props.providerID]: protocolPatch(current, state.choice, state.models) },
      })
      showToast({ title: language.t("provider.protocol.saved"), description: language.t("provider.protocol.effect") })
      dialog.close()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("pending", false)
    }
  }
  return (
    <Dialog title={language.t("provider.protocol.title")}>
      <form onSubmit={save} class="flex flex-col gap-4 p-6 max-h-[70vh] overflow-auto">
        <p class="text-14-medium">{initial.name ?? props.providerID}</p>
        <p class="text-12-regular text-text-weak">{language.t("provider.protocol.effect")}</p>
        <fieldset disabled={state.pending} class="flex flex-col gap-4">
          <label class="flex flex-col gap-2">
            <span>{language.t("provider.protocol.default")}</span>
            <select
              class="h-10 rounded-md border border-border-base bg-surface-base px-3"
              value={state.choice}
              onChange={(event) => setState("choice", event.currentTarget.value as ProtocolChoice)}
            >
              <option value="openai">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </label>
          <For each={Object.entries(initial.models ?? {})}>
            {([id, model]) => (
              <label class="flex flex-col gap-2">
                <span class="break-all">
                  {model.name ?? id} � {id}
                </span>
                <Show
                  when={!model.provider?.npm || protocolChoice(model.provider.npm)}
                  fallback={
                    <span class="text-text-weak">
                      {language.t("provider.protocol.custom")} � {model.provider?.npm}
                    </span>
                  }
                >
                  <select
                    class="h-10 rounded-md border border-border-base bg-surface-base px-3"
                    value={state.models[id]}
                    onChange={(event) => setState("models", id, event.currentTarget.value)}
                  >
                    <option value="">{language.t("provider.protocol.inherit")}</option>
                    <option value="openai">Chat Completions</option>
                    <option value="responses">Responses</option>
                  </select>
                </Show>
              </label>
            )}
          </For>
          <Show when={state.error}>
            <p role="alert" class="text-text-danger">
              {state.error}
            </p>
          </Show>
          <Button type="submit" variant="primary">
            {language.t("common.save")}
          </Button>
        </fieldset>
      </form>
    </Dialog>
  )
}
