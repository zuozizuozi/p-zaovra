const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
import {
  providerBaseURL,
  providerPresetProtocol,
  providerServiceKey,
  providerProtocols,
  type ProviderProtocol,
  type ProviderModelType,
} from "../provider-discovery"
import type { Config } from "@zaovra-ai/sdk/v2/types"
import { providerDisplayName } from "../provider-label"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  name?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = {
  row: string
  id: string
  name: string
  protocol?: ProviderProtocol
  type?: ProviderModelType
  images?: boolean
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  protocol?: ProviderProtocol
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
}

export function customProviderDefaults(input: {
  form: FormState
  savedProviderID?: string
  providerIDs: Iterable<string>
  providers: Config["provider"]
}) {
  const baseURL = validateProviderURL(
    input.form.baseURL,
    input.form.protocol ?? providerPresetProtocol(input.form.baseURL),
    (key) => key,
  ).baseURL
  const host = baseURL ? new URL(baseURL).hostname : "custom"
  const stem =
    host
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+/, "") || "custom"
  const used = new Set(input.providerIDs)
  const existing = baseURL
    ? Object.entries(input.providers ?? {}).find(
        ([, provider]) => providerServiceKey(provider.options?.baseURL) === baseURL,
      )
    : undefined
  return {
    baseURL: baseURL ?? input.form.baseURL,
    name: providerDisplayName(input.form.name.trim() || existing?.[1].name, baseURL),
    providerID:
      input.form.providerID.trim() ||
      input.savedProviderID ||
      existing?.[0] ||
      Array.from({ length: used.size + 2 }, (_, i) => (i === 0 ? stem : `${stem}-${i + 1}`)).find(
        (id) => !used.has(id),
      )!,
  }
}

export function customProviderEnable(
  providerID: string,
  disconnected: boolean,
  choice: { providerID: string; value: boolean } | undefined,
) {
  return choice?.providerID === providerID ? choice.value : disconnected
}

export function validateProviderURL(value: string, protocol: FormState["protocol"], t: Translator) {
  try {
    return { baseURL: providerBaseURL(value, protocol), error: undefined }
  } catch (error) {
    const reason =
      error instanceof Error &&
      ["required", "format", "protocol", "credentials", "query", "fragment"].includes(error.message)
        ? error.message
        : "format"
    return { baseURL: undefined, error: t(`provider.custom.error.baseURL.${reason}`) }
  }
}

export function validateCustomProvider(input: ValidateArgs) {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const url = validateProviderURL(input.form.baseURL, input.form.protocol, input.t)
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const idError = !providerID
    ? input.t("provider.custom.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("provider.custom.error.providerID.format")
      : undefined

  const nameError = !name ? input.t("provider.custom.error.name.required") : undefined
  const urlError = url.error

  const disabled = input.disabledProviders.includes(providerID)
  const existsError = idError
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled
      ? input.t("provider.custom.error.providerID.exists")
      : undefined

  const seenModels = new Set<string>()
  const models = input.form.models.map((m) => {
    const id = m.id.trim()
    const idError = !id
      ? input.t("provider.custom.error.required")
      : seenModels.has(id)
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenModels.add(id)
            return undefined
          })()
    return { id: idError, name: undefined }
  })
  const modelsValid = models.length > 0 && models.every((m) => !m.id && !m.name)
  const modelConfig: NonNullable<NonNullable<Config["provider"]>[string]["models"]> = Object.fromEntries(
    input.form.models.map((m) => [
      m.id.trim(),
      {
        name: m.name.trim() || m.id.trim(),
        ...(m.images === undefined
          ? {}
          : {
              modalities: {
                input: m.images ? ["text" as const, "image" as const] : ["text" as const],
                output: ["text" as const],
              },
            }),
        ...((input.form.protocol === undefined ||
          input.form.protocol === "openai" ||
          input.form.protocol === "responses") &&
        m.protocol
          ? {
              provider: {
                npm: providerProtocols[m.protocol].npm,
                ...(m.protocol === "google" && url.baseURL ? { api: url.baseURL.replace(/\/v1$/, "/v1beta") } : {}),
              },
            }
          : {}),
      },
    ]),
  )

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
  }

  const ok = !idError && !existsError && !nameError && !urlError && modelsValid && headersValid
  if (!ok) return { err, models, headers }

  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        npm: providerProtocols[input.form.protocol ?? "openai"].npm as string,
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL: url.baseURL!,
          ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
        whitelist: Object.keys(modelConfig),
      },
    },
  }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({ row: nextRow(), id: "", name: "", err: {} })
export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })
