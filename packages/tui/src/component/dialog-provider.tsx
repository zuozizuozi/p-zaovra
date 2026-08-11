import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { IntegrationAttempt, IntegrationMethod } from "@zaovra-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"

const PROVIDER_PRIORITY: Record<string, number> = {
  zaovra: 0,
  "zaovra-go": 1,
  openai: 2,
  "github-copilot": 3,
  anthropic: 4,
  google: 5,
}

const CUSTOM_PROVIDER_OPTION_VALUE = "__zaovra_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ConnectMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[]): ProviderOption[] {
  return [
    ...pipe(
      list,
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          zaovra: "(Recommended)",
          anthropic: "(API key)",
          openai: "(ChatGPT Plus/Pro or API key)",
          "zaovra-go": "Low cost subscription for everyone",
        }[provider.id],
        category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Providers",
      })),
    ),
    {
      type: "custom",
      title: "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: "Custom provider",
      category: "Providers",
    },
  ]
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

export function createDialogProviderOptions() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()

  async function promptCustomProviderID(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, "Other", {
      placeholder: "Provider id",
      description: () => (
        <text fg={theme.textMuted}>
          This only stores a credential. Configure the provider in zaovra.json to use it.
        </text>
      ),
    })
    if (value === null) return

    const providerID = normalizeCustomProviderID(value)
    if (providerID) return providerID

    toast.show({
      variant: "error",
      message:
        "Provider ids must start with a lowercase letter or number and only use lowercase letters, numbers, hyphens, and underscores",
    })
    return promptCustomProviderID()
  }

  async function selectProviderMethod(providerID: string, custom = false) {
    const location = sdk.directory ? { directory: sdk.directory } : undefined
    const integrationID = custom
      ? providerID
      : await sdk.client.v2.provider
          .get({ providerID, location }, { throwOnError: true })
          .then((response) => response.data.data.integrationID ?? providerID)
          .catch((error) => {
            toast.error(error)
            return undefined
          })
    if (!integrationID) return

    const integration = await sdk.client.v2.integration
      .get({ integrationID, location }, { throwOnError: true })
      .then((response) => response.data.data)
      .catch((error) => {
        toast.error(error)
        return undefined
      })
    if (!integration) {
      toast.show({
        variant: "error",
        message: custom
          ? `Configure ${providerID} in zaovra.json before connecting it.`
          : `Provider ${providerID} has no registered integration.`,
      })
      return
    }

    const methods = integration.methods.filter(
      (method): method is ConnectMethod => method.type === "key" || method.type === "oauth",
    )
    if (methods.length === 0) {
      toast.show({ variant: "error", message: `Provider ${providerID} has no supported authentication method.` })
      return
    }

    const index =
      methods.length === 1
        ? 0
        : await new Promise<number | null>((resolve) => {
            dialog.replace(
              () => (
                <DialogSelect
                  title="Select auth method"
                  options={methods.map((method, index) => ({
                    title: method.type === "key" ? (method.label ?? "API key") : method.label,
                    value: index,
                  }))}
                  onSelect={(option) => resolve(option.value)}
                />
              ),
              () => resolve(null),
            )
          })
    if (index === null) return
    const method = methods[index]
    const inputs = method.prompts?.length
      ? await PromptsMethod({ dialog, prompts: method.prompts })
      : undefined
    if (inputs === null) return

    if (method.type === "key") {
      dialog.replace(() => (
        <ApiMethod
          providerID={providerID}
          integrationID={integrationID}
          title={method.label ?? "API key"}
          inputs={inputs}
        />
      ))
      return
    }

    const authorization = await sdk.client.v2.integration.connect
      .oauth(
        {
          integrationID,
          location,
          methodID: method.id,
          inputs: inputs ?? {},
        },
        { throwOnError: true },
      )
      .then((response) => response.data.data)
      .catch((error) => {
        toast.error(error)
        return undefined
      })
    if (!authorization) return
    if (authorization.mode === "code") {
      dialog.replace(() => <CodeMethod providerID={providerID} title={method.label} authorization={authorization} />)
      return
    }
    dialog.replace(() => <AutoMethod providerID={providerID} title={method.label} authorization={authorization} />)
  }

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: provider.title,
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              const providerID = await promptCustomProviderID()
              if (!providerID) return
              return selectProviderMethod(providerID, true)
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return
            return selectProviderMethod(providerID)
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const options = createDialogProviderOptions()
  return <DialogSelect title="Connect a provider" options={options()} />
}

interface AutoMethodProps {
  providerID: string
  title: string
  authorization: IntegrationAttempt
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const clipboard = useClipboard()

  useBindings(() => ({
    bindings: [
      {
        key: "c",
        desc: "Copy provider code",
        group: "Dialog",
        cmd: () => {
          const code =
            props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
          clipboard
            .write?.(code)
            .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
            .catch(toast.error)
        },
      },
    ],
  }))

  const location = sdk.directory ? { directory: sdk.directory } : undefined
  const settled = { value: false }
  const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    if (timer.value !== undefined) clearTimeout(timer.value)
    if (settled.value) return
    void sdk.client.v2.integration.attempt
      .cancel({ attemptID: props.authorization.attemptID, location }, { throwOnError: true })
      .catch(() => undefined)
  })

  onMount(() => {
    const poll = async () => {
      const status = await sdk.client.v2.integration.attempt
        .status({ attemptID: props.authorization.attemptID, location }, { throwOnError: true })
        .then((response) => response.data.data)
        .catch((error) => {
          toast.error(error)
          return undefined
        })
      if (!status) {
        dialog.clear()
        return
      }
      if (status.status === "complete") {
        settled.value = true
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
        return
      }
      if (status.status === "failed" || status.status === "expired") {
        settled.value = true
        toast.show({
          variant: "error",
          message: status.status === "failed" ? status.message : "OAuth authorization expired. Try /connect again.",
        })
        dialog.clear()
        return
      }
      timer.value = setTimeout(() => void poll(), 500)
    }
    void poll()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  title: string
  providerID: string
  authorization: IntegrationAttempt
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)
  const location = sdk.directory ? { directory: sdk.directory } : undefined
  const settled = { value: false }

  onCleanup(() => {
    if (settled.value) return
    void sdk.client.v2.integration.attempt
      .cancel({ attemptID: props.authorization.attemptID, location }, { throwOnError: true })
      .catch(() => undefined)
  })

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const result = await sdk.client.v2.integration.attempt
          .complete(
            { attemptID: props.authorization.attemptID, location, code: value },
            { throwOnError: true },
          )
          .then(() => true)
          .catch(() => false)
        if (result) {
          settled.value = true
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          dialog.replace(() => <DialogModel providerID={props.providerID} />)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  integrationID: string
  title: string
  inputs?: Record<string, string>
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={() =>
        ({
          zaovra: (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Zaovra Zen gives you access to all the best coding models at the cheapest prices with a single API
                key.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://zaovra.com/zen</span> to get a key
              </text>
            </box>
          ),
          "zaovra-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>
                Zaovra Go is a $10 per month subscription that provides reliable access to popular open coding models
                with generous usage limits.
              </text>
              <text fg={theme.text}>
                Go to <span style={{ fg: theme.primary }}>https://zaovra.com/go</span> and enable Zaovra Go
              </text>
            </box>
          ),
        })[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.v2.integration.connect.key(
          {
            integrationID: props.integrationID,
            location: sdk.directory ? { directory: sdk.directory } : undefined,
            key: value,
            inputs: props.inputs,
          },
          { throwOnError: true },
        )
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        dialog.replace(() => <DialogModel providerID={props.providerID} />)
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ConnectMethod["prompts"]>
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
