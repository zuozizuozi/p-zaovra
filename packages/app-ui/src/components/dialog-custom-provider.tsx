import { primaryProviderModel, isProviderAutoModel } from "@/context/model-choice"
import { useModelService } from "@/hooks/use-model-service"
import { Button } from "@zaovra-ai/ui/button"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { IconButton } from "@zaovra-ai/ui/icon-button"
import { ProviderIcon } from "@zaovra-ai/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@zaovra-ai/ui/text-field"
import { showToast } from "@/utils/toast"
import { batch, For, Show, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useModels } from "@/context/models"
import {
  discoverProviderModels,
  providerBaseURL,
  providerBaseURLCorrection,
  providerModelType,
  providerModelTypes,
  type ProviderModelType,
  type ProviderProtocol,
  providerServiceKey,
  providerPresetProtocol,
  detectProviderProtocol,
  providerProtocols,
  changeProviderProtocolURL,
} from "@/provider-discovery"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { providerOperation, reconnectDisabledProviders, resolveProviderIntegration } from "@/utils/provider-integration"
import {
  type FormState,
  type ModelRow,
  headerRow,
  modelRow,
  customProviderDefaults,
  validateCustomProvider,
  validateProviderURL,
} from "./dialog-custom-provider-form"

type Props = {
  onBack: () => void
}

export function DialogCustomProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full"
      title={
        <IconButton icon="arrow-left" variant="ghost" onClick={props.onBack} aria-label={language.t("common.goBack")} />
      }
    >
      <CustomProviderForm />
    </Dialog>
  )
}

export function CustomProviderForm(props: { autofocus?: boolean } = {}) {
  const dialog = useDialog()
  const service = useModelService()
  const platform = usePlatform()
  const catalog = useModels()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [form, setForm] = createStore<FormState>({
    protocol: undefined,
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })

  const [discovery, setDiscovery] = createStore({
    models: [] as { id: string; name: string; type?: ProviderModelType; protocol?: FormState["protocol"] }[],
    query: "",
    pending: false,
    error: "",

    advanced: false,
    normalizedURL: "",
  })
  const alive = { value: true }
  const operation = providerOperation()
  const modelType = (model: ModelRow) => model.type ?? providerModelType(model) ?? "chat"
  const saved = { providerID: undefined as string | undefined }
  onCleanup(() => {
    alive.value = false
    operation.cancel()
  })
  const automatic = () =>
    customProviderDefaults({
      form,
      savedProviderID: saved.providerID,
      providerIDs: serverSync().data.provider.all.keys(),
      providers: serverSync().data.config.provider,
    })
  const normalizeURL = () => {
    const selected = form.protocol ?? providerPresetProtocol(form.baseURL)
    const url = validateProviderURL(form.baseURL, selected, language.t)
    setForm("err", "baseURL", url.error)
    if (url.baseURL && providerBaseURLCorrection(form.baseURL, selected)) {
      setDiscovery("normalizedURL", url.baseURL)
      setForm("baseURL", url.baseURL)
    }
    return url
  }
  const discover = async () => {
    const protocol = form.protocol
    if (discovery.pending || saveMutation.isPending) return
    const selected = form.protocol ?? providerPresetProtocol(form.baseURL)
    const url = normalizeURL()
    if (!url.baseURL) return
    setDiscovery({ pending: true, error: "" })
    const current = operation.start()
    try {
      const input = {
        baseURL: url.baseURL,
        apiKey: form.apiKey,
        kind: selected === "responses" ? ("openai" as const) : selected,
        headers: Object.fromEntries(
          form.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value.trim()]),
        ),
      }
      const models = (await (platform.discoverProviderModels ?? discoverProviderModels)(input)).filter(
        (m) => !isProviderAutoModel(m.id),
      )
      if (!current() || !alive.value || protocol !== form.protocol || input.apiKey !== form.apiKey) return
      if (models.length === 0) throw new Error("noChatModels")
      batch(() => {
        setDiscovery({ models, query: "" })
        setForm("baseURL", input.baseURL)
        setForm(
          "models",
          models.map((model) => ({
            ...modelRow(),
            ...model,
            protocol: form.protocol === undefined ? model.protocol : undefined,
          })),
        )
      })
    } catch (error) {
      if (!current() || !alive.value) return
      const message = error instanceof Error ? error.message : ""
      const key = /restart/.test(message)
        ? "restart"
        : /environment/.test(message)
          ? "environment"
          : /Timeout|timeout|abort/i.test(message)
            ? "timeout"
            : /http40[45]/.test(message)
              ? "unsupported"
              : /http40[13]/.test(message)
                ? "auth"
                : /http429/.test(message)
                  ? "rate"
                  : /invalidURL|Invalid URL/.test(message)
                    ? "url"
                    : /noChatModels/.test(message)
                      ? "noChatModels"
                      : /empty/.test(message)
                        ? "empty"
                        : "failed"
      setDiscovery({
        error:
          /http40[04]/.test(message) && discovery.normalizedURL
            ? language.t("provider.custom.discovery.endpointError", { url: discovery.normalizedURL })
            : language.t(`provider.custom.discovery.${key}`),
      })
    } finally {
      if (current() && alive.value) setDiscovery("pending", false)
    }
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    if (discovery.models.length) {
      setDiscovery({ models: [], error: "" })
      setForm("models", [modelRow()])
    }
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    if (key === "baseURL") setDiscovery("normalizedURL", "")
    if ((key === "baseURL" || key === "apiKey") && discovery.models.length) {
      setDiscovery({ models: [], error: "" })
      setForm("models", [modelRow()])
    }
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    if (discovery.models.length) {
      setDiscovery({ models: [], error: "" })
      setForm("models", [modelRow()])
    }
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const defaults = automatic()
    const output = validateCustomProvider({
      form: { ...form, ...defaults },
      t: language.t,
      disabledProviders: serverSync().data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(
        [...serverSync().data.provider.all.keys()].filter(
          (id) =>
            id !== saved.providerID &&
            !(
              id === defaults.providerID &&
              providerServiceKey(serverSync().data.config.provider?.[id]?.options?.baseURL) === defaults.baseURL
            ),
        ),
      ),
    })
    batch(() => {
      setForm("err", output.err)
      if (output.err.providerID || output.err.name || output.headers.some((error) => error.key || error.value))
        setDiscovery("advanced", true)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const snapshot = (result: NonNullable<ReturnType<typeof validate>>) => {
    const valid = operation.start()
    const sdk = serverSDK()
    return {
      ...result,
      protocol: form.protocol,
      apiKey: form.apiKey,
      models: form.models.map((model) => ({ ...model })),
      sdk,
      sync: serverSync(),
      enable: true,
      current: () => valid() && alive.value && serverSDK() === sdk,
    }
  }
  const saveMutation = useMutation(() => ({
    mutationFn: async (result: ReturnType<typeof snapshot>) => {
      if (!result.current()) return
      if (result.protocol === undefined) {
        const detected: { protocol?: ProviderProtocol } = {}
        for (const model of result.models) {
          if (modelType(model) !== "chat") continue
          const protocol =
            model.protocol ??
            detected.protocol ??
            (await (platform.detectProviderProtocol ?? detectProviderProtocol)({
              baseURL: result.config.options.baseURL,
              apiKey: result.apiKey,
              modelID: model.id.trim(),
              modelType: modelType(model),
              headers: result.config.options.headers,
            }))
          if (!result.current()) return
          detected.protocol = protocol
          result.config.models[model.id.trim()] = {
            ...result.config.models[model.id.trim()]!,
            provider: {
              npm: providerProtocols[protocol].npm,
              ...(protocol === "google" ? { api: result.config.options.baseURL.replace(/\/v1$/, "/v1beta") } : {}),
            },
          }
          result.config.npm = providerProtocols[protocol].npm
        }
      }
      const before = result.sync.data.config.provider?.[result.providerID]
      if (result.protocol === undefined && before?.npm) result.config.npm = before.npm
      result.config.models = Object.fromEntries(
        Object.entries(result.config.models).map(([id, model]) => [id, { ...before?.models?.[id], ...model }]),
      )
      if (!result.current()) return
      const primary = primaryProviderModel(result.models)
      await result.sync.updateConfig({
        provider: { [result.providerID]: result.config },
        ...(primary ? { model: result.providerID + "/" + primary.id } : {}),
      })
      if (!result.current()) return
      for (const model of result.models)
        catalog.setType(
          { providerID: result.providerID, modelID: model.id.trim() },
          model.type ?? providerModelType(model),
        )
      // A credential failure must retry the same config, not create another provider.
      saved.providerID = result.providerID
      if (result.key) {
        const resolved = await resolveProviderIntegration(result.sdk.client, result.providerID)
        if (!result.current()) return
        if (!resolved.integration?.methods.some((method) => method.type === "key")) {
          throw new Error(`Provider ${result.providerID} does not expose a key integration`)
        }
        await result.sdk.client.v2.integration.connect.key(
          {
            integrationID: resolved.integrationID,
            location: resolved.location,
            key: result.key,
            inputs: {},
          },
          { throwOnError: true },
        )
        if (!result.current()) return
        await result.sdk.client.global.dispose({ throwOnError: true })
      }
      if (!result.current()) return
      if (result.enable) {
        const disabled = result.sync.data.config.disabled_providers ?? []
        if (disabled.includes(result.providerID))
          await result.sync
            .updateConfig({
              disabled_providers: reconnectDisabledProviders(disabled, result.providerID, true),
            })
            .catch(() => {
              throw new Error("providerReenableFailed")
            })
        if (!result.current()) return
      }
      service.disconnect(result.providerID, false)
      await result.sync.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === result.sdk.scope && query.queryKey[2] === "providers",
      })
      if (!result.current()) return
      await result.sync.queryClient.fetchQuery({ ...result.sync.queryOptions.providers(null), staleTime: 0 })
      if (!result.current()) return
      return result
    },
    onSuccess: (result) => {
      if (!result?.current()) return
      service.select(result.providerID)
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.custom.discovery.saved", { provider: result.name }),
        description: language.t("provider.custom.discovery.savedDescription"),
      })
    },
    onError: (err, result) => {
      if (!result.current()) return
      const message = err instanceof Error ? err.message : String(err)
      const type = message.startsWith("nonChatModel:")
        ? providerModelType(form.models.find((model) => providerModelType(model)) ?? { id: "" })
        : undefined
      const endpoint = message.startsWith("endpointURL:")
        ? message.slice("endpointURL:".length)
        : discovery.normalizedURL
      const description = type
        ? language.t("provider.custom.error.nonChatModel", { type: language.t(`provider.custom.modelType.${type}`) })
        : message === "providerReenableFailed"
          ? language.t("provider.connect.disabled.failed")
          : /^(invalidModelReply|echoedModelReply)$/.test(message)
            ? language.t("provider.custom.discovery.invalidReply")
            : endpoint && (/HTTP 40[04]/.test(message) || message.startsWith("endpointURL:"))
              ? language.t("provider.custom.discovery.endpointError", { url: endpoint })
              : message
      showToast({ title: language.t("common.requestFailed"), description })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending || discovery.pending) return

    if (!form.models.some((model) => model.id.trim())) {
      setDiscovery({ error: language.t("provider.custom.discovery.choose") })
      return
    }
    const url = normalizeURL()
    if (!url.baseURL) return
    const result = (() => {
      try {
        return validate()
      } catch {
        setForm("err", "baseURL", language.t("provider.custom.error.baseURL.format"))
      }
    })()
    if (!result) return
    saveMutation.mutate(snapshot(result))
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
      </div>

      <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
        <p class="text-14-regular text-text-base">{language.t("provider.custom.discovery.intro")}</p>
        <fieldset disabled={discovery.pending || saveMutation.isPending} class="flex min-w-0 flex-col gap-6">
          <div class="flex flex-col gap-4">
            <TextField
              autofocus={props.autofocus ?? true}
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={providerProtocols[form.protocol ?? "openai"].baseURL}
              value={form.baseURL}
              onChange={(v) => setField("baseURL", v)}
              validationState={form.err.baseURL ? "invalid" : undefined}
              error={form.err.baseURL}
              description={
                providerBaseURLCorrection(form.baseURL, form.protocol ?? providerPresetProtocol(form.baseURL))
                  ? language.t("provider.custom.discovery.willNormalize", {
                      url: providerBaseURL(form.baseURL, form.protocol ?? providerPresetProtocol(form.baseURL)),
                    })
                  : discovery.normalizedURL
                    ? language.t("provider.custom.discovery.normalized", { url: discovery.normalizedURL })
                    : undefined
              }
            />
            <TextField
              type="password"
              autocomplete="off"
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={language.t("provider.custom.field.apiKey.description")}
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <Button type="button" variant="primary" onClick={() => void discover()}>
              {discovery.pending
                ? language.t("provider.custom.discovery.loading")
                : language.t("provider.custom.discovery.fetch")}
            </Button>
          </div>
          <Show when={discovery.error}>
            <p role="alert" class="text-14-regular text-text-danger">
              {discovery.error}
            </p>
          </Show>
          <Show when={discovery.models.length > 0}>
            <section class="flex flex-col gap-3">
              <p role="status" class="text-12-regular text-text-weak">
                {language.t("provider.custom.discovery.success")}
              </p>
              <p class="text-12-regular text-text-weak">{language.t("provider.custom.discovery.chatOnly")}</p>
              <TextField
                label={language.t("provider.custom.discovery.search")}
                value={discovery.query}
                onChange={(value) => setDiscovery("query", value)}
              />
              <div class="flex max-h-48 flex-col gap-2 overflow-y-auto">
                <For
                  each={discovery.models.filter((model) =>
                    `${model.id} ${model.name}`.toLowerCase().includes(discovery.query.toLowerCase()),
                  )}
                >
                  {(model) => (
                    <label class="flex items-center gap-2 text-14-regular">
                      <span class="min-w-0 break-all">
                        {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
                        <Show when={model.type && model.type !== "chat"}>
                          <span class="block text-12-regular text-text-weak">
                            {language.t(`provider.custom.modelType.${model.type!}`)} ·{" "}
                            {language.t("provider.custom.modelType.notice")}
                          </span>
                        </Show>
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Show
            when={
              discovery.advanced &&
              (form.protocol === undefined || form.protocol === "openai" || form.protocol === "responses") &&
              discovery.models.length > 0
            }
          >
            <For each={form.models}>
              {(model, index) => (
                <label class="flex flex-col gap-2 text-14-regular">
                  <span>
                    {model.id || language.t("provider.custom.models.id.label")} ·{" "}
                    {language.t("provider.custom.protocol.label")}
                  </span>
                  <select
                    class="h-10 rounded-md border border-border-base bg-surface-base px-3"
                    value={model.protocol ?? ""}
                    onChange={(event) =>
                      setForm(
                        "models",
                        index(),
                        "protocol",
                        event.currentTarget.value === "" ? undefined : (event.currentTarget.value as ProviderProtocol),
                      )
                    }
                  >
                    <option value="">{language.t("provider.protocol.inherit")}</option>
                    <For each={Object.entries(providerProtocols)}>
                      {([value, protocol]) => <option value={value}>{protocol.label}</option>}
                    </For>
                  </select>
                </label>
              )}
            </For>
          </Show>
          <details open={discovery.advanced} onToggle={(event) => setDiscovery("advanced", event.currentTarget.open)}>
            <summary class="cursor-pointer text-14-medium">{language.t("provider.custom.discovery.advanced")}</summary>
            <div class="mt-4 flex flex-col gap-4">
              <For each={form.models}>
                {(model, index) => (
                  <label class="flex flex-col gap-2 text-14-regular">
                    <span>
                      {model.id || language.t("provider.custom.models.id.label")} ·{" "}
                      {language.t("provider.custom.modelType.label")}
                    </span>
                    <select
                      aria-label={`${model.id || language.t("provider.custom.models.id.label")} · ${language.t("provider.custom.modelType.label")}`}
                      value={model.type ?? "auto"}
                      class="h-10 w-full rounded-md border border-border-base bg-surface-base px-3"
                      onChange={(event) =>
                        setForm(
                          "models",
                          index(),
                          "type",
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
                  </label>
                )}
              </For>
              <label class="flex flex-col gap-2 text-14-regular">
                <span>{language.t("provider.custom.protocol.label")}</span>
                <select
                  aria-label={language.t("provider.custom.protocol.label")}
                  value={form.protocol ?? "auto"}
                  class="h-10 w-full rounded-md border border-border-base bg-surface-base px-3 text-text-base focus-visible:outline focus-visible:outline-2"
                  onChange={(event) => {
                    const protocol =
                      event.currentTarget.value === "auto"
                        ? undefined
                        : (event.currentTarget.value as NonNullable<FormState["protocol"]>)
                    if (protocol === form.protocol) return
                    const baseURL = changeProviderProtocolURL(
                      form.baseURL,
                      form.protocol ?? "openai",
                      protocol ?? "openai",
                    )
                    batch(() => {
                      setForm("protocol", protocol)
                      setForm("baseURL", baseURL)
                      setForm("models", [modelRow()])
                      setDiscovery({ models: [], error: "", query: "" })
                    })
                  }}
                >
                  <option value="auto">{language.t("provider.custom.protocol.auto")}</option>
                  <For each={Object.entries(providerProtocols)}>
                    {([value, protocol]) => <option value={value}>{protocol.label}</option>}
                  </For>
                </select>
                <span class="text-12-regular text-text-weak">{language.t("provider.custom.protocol.hint")}</span>
              </label>

              <TextField
                label={language.t("provider.custom.field.providerID.label")}
                placeholder={language.t("provider.custom.discovery.auto")}
                value={form.providerID}
                onChange={(v) => setField("providerID", v)}
                validationState={form.err.providerID ? "invalid" : undefined}
                error={form.err.providerID}
              />
              <TextField
                label={language.t("provider.custom.field.name.label")}
                placeholder={language.t("provider.custom.discovery.auto")}
                value={form.name}
                onChange={(v) => setField("name", v)}
                validationState={form.err.name ? "invalid" : undefined}
                error={form.err.name}
              />
              <div class="flex flex-col gap-3">
                <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
                <For each={form.headers}>
                  {(h, i) => (
                    <div class="flex gap-2 items-start" data-row={h.row}>
                      <div class="flex-1">
                        <TextField
                          label={language.t("provider.custom.headers.key.label")}
                          hideLabel
                          placeholder={language.t("provider.custom.headers.key.placeholder")}
                          value={h.key}
                          onChange={(v) => setHeader(i(), "key", v)}
                          validationState={h.err.key ? "invalid" : undefined}
                          error={h.err.key}
                        />
                      </div>
                      <div class="flex-1">
                        <TextField
                          label={language.t("provider.custom.headers.value.label")}
                          hideLabel
                          placeholder={language.t("provider.custom.headers.value.placeholder")}
                          value={h.value}
                          onChange={(v) => setHeader(i(), "value", v)}
                          validationState={h.err.value ? "invalid" : undefined}
                          error={h.err.value}
                        />
                      </div>
                      <IconButton
                        type="button"
                        icon="trash"
                        variant="ghost"
                        class="mt-1.5"
                        onClick={() => removeHeader(i())}
                        disabled={form.headers.length <= 1}
                        aria-label={language.t("provider.custom.headers.remove")}
                      />
                    </div>
                  )}
                </For>
                <Button
                  type="button"
                  size="small"
                  variant="ghost"
                  icon="plus-small"
                  onClick={addHeader}
                  class="self-start"
                >
                  {language.t("provider.custom.headers.add")}
                </Button>
              </div>
            </div>
          </details>
        </fieldset>

        <Show when={form.protocol === undefined}>
          <p class="text-12-regular text-text-weak">{language.t("provider.custom.protocol.autoHint")}</p>
        </Show>
        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending || discovery.pending || discovery.models.length === 0}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("provider.custom.discovery.save")}
        </Button>
      </form>
    </div>
  )
}
