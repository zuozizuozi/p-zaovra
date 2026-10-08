import { For, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { Button } from "@zaovra-ai/ui/button"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { protocolChoice, protocolPatch, priceErrors, type ProtocolChoice } from "./provider-protocol"

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
    images: Object.fromEntries(
      Object.entries(initial.models ?? {}).map(([id, model]) => [
        id,
        model.modalities?.input?.includes("image") ?? false,
      ]),
    ),
    pending: false,
    prices: Object.fromEntries(
      Object.entries(initial.models ?? {}).map(([id, model]) => [
        id,
        {
          input: String(model.cost?.input ?? ""),
          output: String(model.cost?.output ?? ""),
          cache_read: String(model.cost?.cache_read ?? ""),
          cache_write: String(model.cost?.cache_write ?? ""),
        },
      ]),
    ),
    error: "",
    fieldErrors: {} as ReturnType<typeof priceErrors>,
  })
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.pending) return
    const errors = priceErrors(initial, state.prices)
    setState("fieldErrors", errors)
    if (Object.values(errors).some((fields) => Object.keys(fields).length)) {
      setState("error", language.t("usage.priceInvalid"))
      return
    }
    setState({ pending: true, error: "" })
    try {
      // Read the latest configuration, preserving unrelated edits and credentials.
      const current = sync().data.config.provider?.[props.providerID]
      if (
        !current ||
        current.npm !== initial.npm ||
        Object.entries(initial.models ?? {}).some(
          ([id, model]) =>
            !current.models?.[id] ||
            current.models[id].provider?.npm !== model.provider?.npm ||
            JSON.stringify(current.models[id].cost) !== JSON.stringify(model.cost) ||
            JSON.stringify(current.models[id].modalities?.input) !== JSON.stringify(model.modalities?.input),
        )
      )
        throw new Error(language.t("provider.protocol.changed"))
      await sync().updateConfig({
        provider: {
          [props.providerID]: protocolPatch(current, state.choice, state.models, state.images, state.prices),
        },
      })
      showToast({ title: language.t("provider.protocol.saved"), description: language.t("usage.priceSaved") })
      dialog.close()
    } catch (error) {
      setState(
        "error",
        error instanceof Error && error.message.startsWith("price-")
          ? language.t("usage.priceInvalid")
          : error instanceof Error
            ? error.message
            : String(error),
      )
    } finally {
      setState("pending", false)
    }
  }
  return (
    <Dialog title={language.t("provider.protocol.title")}>
      <form noValidate onSubmit={save} class="flex flex-col gap-4 p-6 max-h-[70vh] overflow-auto">
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
              <div class="flex flex-col gap-2">
                <span class="break-all">{model.name && model.name !== id ? `${model.name} · ${id}` : id}</span>
                <Show
                  when={!model.provider?.npm || protocolChoice(model.provider.npm)}
                  fallback={
                    <span class="text-text-weak">
                      {language.t("provider.protocol.custom")} · {model.provider?.npm}
                    </span>
                  }
                >
                  <select
                    aria-label={model.name ?? id}
                    class="h-10 rounded-md border border-border-base bg-surface-base px-3"
                    value={state.models[id]}
                    onChange={(event) => setState("models", id, event.currentTarget.value)}
                  >
                    <option value="">{language.t("provider.protocol.inherit")}</option>
                    <option value="openai">Chat Completions</option>
                    <option value="responses">Responses</option>
                  </select>
                </Show>
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.images[id]}
                    onChange={(event) => setState("images", id, event.currentTarget.checked)}
                  />
                  <span>{language.t("provider.protocol.imageInput")}</span>
                </label>
                <details open={Object.keys(state.fieldErrors[id] ?? {}).length > 0 ? true : undefined}>
                  <summary>{language.t("usage.priceSettings")}</summary>
                  <p class="text-12-regular text-text-weak">{language.t("usage.priceHint")}</p>
                  <p class="text-12-regular text-text-weak break-all">
                    {language.t("usage.priceClear", {
                      directory: sync().data.path.config,
                      provider: props.providerID,
                      model: id,
                    })}
                  </p>
                  <For each={["input", "output", "cache_read", "cache_write"] as const}>
                    {(key) => (
                      <label class="flex justify-between gap-2 py-1">
                        <span>
                          {language.t(
                            key === "cache_read"
                              ? "usage.cacheRead"
                              : key === "cache_write"
                                ? "usage.cacheWrite"
                                : key === "output"
                                  ? "usage.outputIncludingReasoning"
                                  : "usage.input",
                          )}
                        </span>
                        <div>
                          <input
                            class="w-28 border rounded px-2"
                            type="text"
                            inputmode="decimal"
                            aria-invalid={!!state.fieldErrors[id]?.[key]}
                            value={state.prices[id][key]}
                            onInput={(event) => setState("prices", id, key, event.currentTarget.value)}
                          />
                          <Show when={state.fieldErrors[id]?.[key]}>
                            {(error) => (
                              <p role="alert" class="text-text-danger text-12-regular">
                                {language.t(error() === "required" ? "usage.priceRequired" : "usage.priceNonnegative")}
                              </p>
                            )}
                          </Show>
                        </div>
                      </label>
                    )}
                  </For>
                </details>
              </div>
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
