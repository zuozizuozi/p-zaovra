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
import { discoverProviderModels, providerBaseURL } from "@/provider-discovery"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { resolveProviderIntegration } from "@/utils/provider-integration"
import { type FormState, headerRow, modelRow, validateCustomProvider } from "./dialog-custom-provider-form"

type Props = {
  onBack: () => void
}

export function DialogCustomProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <CustomProviderForm />
    </Dialog>
  )
}

export function CustomProviderForm(props: { autofocus?: boolean } = {}) {
  const dialog = useDialog()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const [form, setForm] = createStore<FormState>({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })

  const [discovery, setDiscovery] = createStore({
    models: [] as { id: string; name: string }[],
    query: "",
    pending: false,
    error: "",
    manual: false,
    advanced: false,
  })
  const alive = { value: true }
  onCleanup(() => {
    alive.value = false
  })
  const automatic = () => {
    const baseURL = providerBaseURL(form.baseURL)
    const host = new URL(baseURL).hostname
    const stem =
      host
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/^-+/, "") || "custom"
    const used = new Set(serverSync().data.provider.all.keys())
    const id = Array.from({ length: used.size + 2 }, (_, i) => (i === 0 ? stem : `${stem}-${i + 1}`)).find(
      (id) => !used.has(id),
    )!
    return { baseURL, name: form.name.trim() || host, providerID: form.providerID.trim() || id }
  }
  const discover = async () => {
    if (discovery.pending || saveMutation.isPending) return
    setDiscovery({ pending: true, error: "" })
    try {
      const input = {
        baseURL: providerBaseURL(form.baseURL),
        apiKey: form.apiKey,
        headers: Object.fromEntries(
          form.headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value.trim()]),
        ),
      }
      const models = await (platform.discoverProviderModels ?? discoverProviderModels)(input)
      if (!alive.value) return
      batch(() => {
        setDiscovery({ models, manual: false, query: "" })
        setForm("baseURL", input.baseURL)
        setForm("models", [{ ...modelRow(), ...models[0] }])
      })
    } catch (error) {
      if (!alive.value) return
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
                    : /empty/.test(message)
                      ? "empty"
                      : "failed"
      setDiscovery({ error: language.t(`provider.custom.discovery.${key}`), manual: true })
    } finally {
      if (alive.value) setDiscovery("pending", false)
    }
  }

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
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
      if (!discovery.manual) setForm("models", [modelRow()])
    }
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    if ((key === "baseURL" || key === "apiKey") && discovery.models.length) {
      setDiscovery({ models: [], error: "" })
      if (!discovery.manual) setForm("models", [modelRow()])
    }
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    if (discovery.models.length) {
      setDiscovery({ models: [], error: "" })
      if (!discovery.manual) setForm("models", [modelRow()])
    }
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateCustomProvider({
      form: { ...form, ...automatic() },
      t: language.t,
      disabledProviders: serverSync().data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(serverSync().data.provider.all.keys()),
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

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const disabledProviders = serverSync().data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      await serverSync().updateConfig({
        provider: { [result.providerID]: result.config },
        disabled_providers: nextDisabled,
      })
      if (result.key) {
        const resolved = await resolveProviderIntegration(serverSDK().client, result.providerID)
        if (!resolved.integration?.methods.some((method) => method.type === "key")) {
          throw new Error(`Provider ${result.providerID} does not expose a key integration`)
        }
        await serverSDK().client.v2.integration.connect.key(
          {
            integrationID: resolved.integrationID,
            location: resolved.location,
            key: result.key,
            inputs: {},
          },
          { throwOnError: true },
        )
        await serverSDK().client.global.dispose()
      }
      return result
    },
    onSuccess: (result) => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.custom.discovery.saved", { provider: result.name }),
        description: language.t("provider.custom.discovery.savedDescription"),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending || discovery.pending) return

    if (!form.models.some((model) => model.id.trim())) {
      setDiscovery({ manual: true, error: language.t("provider.custom.discovery.choose") })
      return
    }
    if (!URL.canParse(form.baseURL.trim())) {
      setForm("err", "baseURL", language.t("provider.custom.error.baseURL.format"))
      return
    }
    const result = (() => {
      try {
        return validate()
      } catch {
        setForm("err", "baseURL", language.t("provider.custom.error.baseURL.format"))
      }
    })()
    if (!result) return
    saveMutation.mutate(result)
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
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              value={form.baseURL}
              onChange={(v) => setField("baseURL", v)}
              validationState={form.err.baseURL ? "invalid" : undefined}
              error={form.err.baseURL}
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
            <Button type="button" variant="ghost" onClick={() => setDiscovery("manual", !discovery.manual)}>
              {language.t("provider.custom.discovery.manual")}
            </Button>
          </div>
          <Show when={discovery.error}>
            <p role="alert" class="text-14-regular text-text-danger">
              {discovery.error}
            </p>
          </Show>
          <Show when={discovery.models.length > 0 && !discovery.manual}>
            <section class="flex flex-col gap-3">
              <p role="status" class="text-12-regular text-text-weak">
                {language.t("provider.custom.discovery.success")}
              </p>
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
                      <input
                        type="checkbox"
                        checked={form.models.some((row) => row.id === model.id)}
                        onChange={(event) => {
                          if (event.currentTarget.checked)
                            return setForm("models", [
                              ...form.models.filter((row) => row.id.trim()),
                              { ...modelRow(), ...model },
                            ])
                          setForm(
                            "models",
                            form.models.filter((row) => row.id !== model.id),
                          )
                        }}
                      />
                      <span class="min-w-0 break-all">
                        {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </section>
          </Show>
          <Show when={discovery.manual}>
            <div class="flex flex-col gap-3">
              <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
              <For each={form.models}>
                {(m, i) => (
                  <div class="flex gap-2 items-start" data-row={m.row}>
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.id.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.id.placeholder")}
                        value={m.id}
                        onChange={(v) => setModel(i(), "id", v)}
                        validationState={m.err.id ? "invalid" : undefined}
                        error={m.err.id}
                      />
                    </div>
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.name.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.name.placeholder")}
                        value={m.name}
                        onChange={(v) => setModel(i(), "name", v)}
                        validationState={m.err.name ? "invalid" : undefined}
                        error={m.err.name}
                      />
                    </div>
                    <IconButton
                      type="button"
                      icon="trash"
                      variant="ghost"
                      class="mt-1.5"
                      onClick={() => removeModel(i())}
                      disabled={form.models.length <= 1}
                      aria-label={language.t("provider.custom.models.remove")}
                    />
                  </div>
                )}
              </For>
              <Button
                type="button"
                size="small"
                variant="ghost"
                icon="plus-small"
                onClick={addModel}
                class="self-start"
              >
                {language.t("provider.custom.models.add")}
              </Button>
            </div>
          </Show>
          <details open={discovery.advanced} onToggle={(event) => setDiscovery("advanced", event.currentTarget.open)}>
            <summary class="cursor-pointer text-14-medium">{language.t("provider.custom.discovery.advanced")}</summary>
            <div class="mt-4 flex flex-col gap-4">
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

        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending || discovery.pending}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("provider.custom.discovery.save")}
        </Button>
      </form>
    </div>
  )
}
