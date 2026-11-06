import { For, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@zaovra-ai/ui/button"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { providerOperation } from "@/utils/provider-integration"
import { parseModelKey } from "@/utils/model-key"
import { providerProtocols, type ProviderProtocol } from "@/provider-discovery"
import { isProviderAutoModel } from "@/context/model-choice"
import { manualProviderModels, providerModelsPatch, providerModelsReady } from "./provider-model-config"

export function ProviderModelFields(props: {
  value: string
  protocol?: ProviderProtocol
  disabled?: boolean
  onChange: (value: string) => void
  onProtocol: (value: ProviderProtocol | undefined) => void
}) {
  const language = useLanguage()
  return (
    <div class="flex w-full flex-col gap-3">
      <label class="flex flex-col gap-2 text-14-regular">
        <span>{language.t("provider.models.ids")}</span>
        <textarea
          class="min-h-20 w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-text-strong"
          value={props.value}
          disabled={props.disabled}
          onInput={(event) => props.onChange(event.currentTarget.value)}
          placeholder={language.t("provider.models.placeholder")}
          spellcheck={false}
        />
        <span class="text-12-regular text-text-weak">{language.t("provider.models.description")}</span>
      </label>
      <label class="flex flex-col gap-2 text-14-regular">
        <span>{language.t("provider.custom.protocol.label")}</span>
        <select
          class="h-10 rounded-md border border-border-base bg-surface-base px-3"
          value={props.protocol ?? ""}
          disabled={props.disabled}
          onChange={(event) =>
            props.onProtocol(event.currentTarget.value ? (event.currentTarget.value as ProviderProtocol) : undefined)
          }
        >
          <option value="">{language.t("provider.protocol.inherit")}</option>
          <For each={Object.entries(providerProtocols)}>
            {([id, protocol]) => <option value={id}>{protocol.label}</option>}
          </For>
        </select>
      </label>
    </div>
  )
}

export function ProviderModelsForm(props: {
  providerID: string
  onSaved?: () => void | boolean | Promise<void | boolean>
}) {
  const sync = useServerSync()
  const sdk = useServerSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const operation = providerOperation()
  onCleanup(operation.cancel)
  const selected = parseModelKey(sync().data.config.model ?? "")
  const ids = Object.keys(sync().data.config.provider?.[props.providerID]?.models ?? {}).filter(
    (id) => !isProviderAutoModel(id),
  )
  const [state, setState] = createStore({
    value: ids.length
      ? ids.join("\n")
      : selected?.providerID === props.providerID && !isProviderAutoModel(selected.modelID)
        ? selected.modelID
        : "",
    protocol: undefined as ProviderProtocol | undefined,
    pending: false,
    error: "",
  })
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.pending) return
    const valid = operation.start()
    const server = sdk()
    const target = sync()
    const providerID = props.providerID
    const current = () => valid() && sdk() === server && props.providerID === providerID
    setState({ pending: true, error: "" })
    try {
      const patch = providerModelsPatch(
        providerID,
        manualProviderModels(state.value),
        target.data.config.provider?.[providerID],
        state.protocol,
      )
      await target.updateConfig(patch)
      if (!current()) return
      const catalog = await target.queryClient.fetchQuery({ ...target.queryOptions.providers(null), staleTime: 0 })
      if (!current()) return
      if (
        !providerModelsReady(
          providerID,
          { ...target.data.config, model: patch.model },
          catalog.all.get(providerID)?.models ?? {},
        )
      )
        throw new Error(language.t("provider.models.unavailable"))
      if (props.onSaved) {
        if ((await props.onSaved()) === false && current()) throw new Error(language.t("provider.models.unavailable"))
      } else dialog.close()
    } catch (error) {
      if (!current()) return
      setState(
        "error",
        error instanceof Error && error.message.startsWith("providerModels")
          ? language.t(`provider.models.${error.message === "providerModelsDuplicate" ? "duplicate" : "required"}`)
          : String(error),
      )
    } finally {
      if (current()) setState("pending", false)
    }
  }
  return (
    <form onSubmit={save} class="flex flex-col gap-4 p-4">
      <p class="text-14-medium text-text-strong">
        {sync().data.provider.all.get(props.providerID)?.name ?? props.providerID}
      </p>
      <p class="text-14-regular text-text-base">{language.t("provider.models.complete")}</p>
      <ProviderModelFields
        value={state.value}
        protocol={state.protocol}
        disabled={state.pending}
        onChange={(value) => setState("value", value)}
        onProtocol={(value) => setState("protocol", value)}
      />
      <p role="alert" class="text-14-regular text-text-danger">
        {state.error}
      </p>
      <Button type="submit" variant="primary" disabled={state.pending}>
        {language.t(state.pending ? "common.saving" : "provider.models.save")}
      </Button>
    </form>
  )
}

export function DialogProviderModels(props: { providerID: string }) {
  const language = useLanguage()
  return (
    <Dialog title={language.t("provider.models.title")}>
      <ProviderModelsForm providerID={props.providerID} />
    </Dialog>
  )
}
