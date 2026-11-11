import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ComponentProps, JSX } from "solid-js"
import type { Config } from "@zaovra-ai/sdk/v2/types"
import { dict } from "../../src/i18n/en"
import { dict as chinese } from "../../src/i18n/zh"

const context = {
  config: {} as Config,
  patches: [] as Partial<Config>[],
  closed: 0,
  locale: "en",
  hold: undefined as Promise<void> | undefined,
}
const catalog = () => ({
  all: new Map([
    [
      "known",
      {
        id: "known",
        name: "Known catalog",
        models: {
          exact: { id: "exact", capabilities: { input: { image: true } } },
        },
      },
    ],
    ...Object.entries(context.config.provider ?? {}).map(
      ([id, provider]) =>
        [
          id,
          {
            id,
            name: id,
            models: Object.fromEntries(
              Object.keys(provider.models ?? {}).map((model) => [
                model,
                { id: model, capabilities: { input: { image: false } } },
              ]),
            ),
          },
        ] as const,
    ),
  ]),
})
const target = {
  data: {
    get config() {
      return context.config
    },
    get provider() {
      return catalog()
    },
    path: { config: "fixture-config" },
  },
  updateConfig: async (patch: Partial<Config>) => {
    context.patches.push(structuredClone(patch))
    await context.hold
    // Only the service boundary is simulated; production form code creates the patch.
    context.config = {
      ...context.config,
      ...patch,
      provider: {
        ...context.config.provider,
        ...Object.fromEntries(
          Object.entries(patch.provider ?? {}).map(([id, provider]) => [
            id,
            {
              ...context.config.provider?.[id],
              ...provider,
              models: { ...context.config.provider?.[id]?.models, ...provider.models },
            },
          ]),
        ),
      },
    }
  },
  queryClient: {
    invalidateQueries: async () => {},
    fetchQuery: async () => catalog(),
  },
  queryOptions: { providers: () => ({ queryKey: ["fixture", "providers"] }) },
}
const server = { client: {}, scope: "fixture" }
mock.module("@/context/server-sync", () => ({ useServerSync: () => () => target }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => server }))
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string, values: Record<string, string> = {}) =>
      Object.entries(values).reduce(
        (text, [name, value]) => text.replaceAll("{{" + name + "}}", value),
        (context.locale === "zh" ? chinese : dict)[key as keyof typeof dict] ?? key,
      ),
  }),
}))
mock.module("@/context/platform", () => ({ usePlatform: () => ({}) }))
mock.module("@/context/models", () => ({ useModels: () => ({ setType: () => {} }) }))
mock.module("@/hooks/use-model-service", () => ({
  useModelService: () => ({ disconnect: () => {}, select: () => {} }),
}))
mock.module("@/utils/toast", () => ({ showToast: () => {} }))
mock.module("@/utils/saved-provider-models", () => ({ refreshSavedProviderModels: async () => [] }))
mock.module("@zaovra-ai/ui/context/dialog", () => ({
  useDialog: () => ({ close: () => context.closed++ }),
}))
mock.module("@zaovra-ai/ui/dialog", () => ({
  Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}))
mock.module("@zaovra-ai/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => (
    <button type={props.type} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))
mock.module("@zaovra-ai/ui/icon-button", () => ({
  IconButton: (props: ComponentProps<"button">) => <button {...props} />,
}))
mock.module("@zaovra-ai/ui/provider-icon", () => ({ ProviderIcon: () => <span /> }))
mock.module("@zaovra-ai/ui/text-field", () => ({
  TextField: (props: { label: string; value?: string; type?: string; onChange: (value: string) => void }) => (
    <label>
      {props.label}
      <input
        aria-label={props.label}
        type={props.type ?? "text"}
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  ),
}))

const { ModelImageInput } = await import("../../src/components/model-image-input")
const { CustomProviderForm } = await import("../../src/components/dialog-custom-provider")
const { DialogProviderProtocol } = await import("../../src/components/dialog-provider-protocol")
const { ProviderModelsForm } = await import("../../src/components/dialog-provider-models")
const cleanups: (() => void)[] = []
function mount(view: () => JSX.Element) {
  const root = document.createElement("div")
  document.body.append(root)
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const dispose = render(() => <QueryClientProvider client={query}>{view()}</QueryClientProvider>, root)
  cleanups.push(() => {
    dispose()
    query.clear()
    root.remove()
  })
  return root
}
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  context.config = {}
  context.patches = []
  context.closed = 0
  context.locale = "en"
  context.hold = undefined
})
function fill(root: HTMLElement, label: string, value: string) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!
  expect(input).not.toBeNull()
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
function choose(input: HTMLInputElement, enabled: boolean) {
  input.checked = enabled
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
function checkbox(root: HTMLElement, id: string) {
  return [...root.querySelectorAll<HTMLElement>('[data-component="model-image-input"]')]
    .find((field) => field.querySelector("label")!.textContent!.startsWith(id + " ·"))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!
}
function submit(root: HTMLElement) {
  root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}
async function settled() {
  await Bun.sleep(20)
}
function prepareCustom() {
  const root = mount(() => <CustomProviderForm autofocus={false} />)
  fill(root, dict["provider.custom.field.baseURL.label"], "https://route.example/v1")
  const protocol = root.querySelector<HTMLSelectElement>(
    'select[aria-label="' + dict["provider.custom.protocol.label"] + '"]',
  )!
  protocol.value = "responses"
  protocol.dispatchEvent(new Event("change", { bubbles: true }))
  fill(root, dict["provider.custom.field.providerID.label"], "route")
  fill(root, dict["provider.custom.models.id.label"], "exact")
  return root
}
const preserved = () =>
  ({
    npm: "@ai-sdk/openai",
    options: { baseURL: "https://route.example/v1" },
    models: {
      exact: {
        modalities: { input: ["text", "audio", "pdf", "image"], output: ["image", "text"] },
        variants: { deep: { reasoningEffort: "high" } },
        provider: { npm: "@ai-sdk/openai", api: "https://route.example/v1" },
      },
      missing: {},
    },
  }) satisfies NonNullable<Config["provider"]>[string]

test("825 actual image control associates consequences, uses exact catalog reference without enabling, and disables", () => {
  const changes: boolean[] = []
  const root = mount(() => <ModelImageInput modelID="exact" onChange={(value) => changes.push(value)} />)
  const input = checkbox(root, "exact")
  expect(input.checked).toBe(false)
  expect(root.querySelector("#" + input.getAttribute("aria-describedby"))?.textContent).toBe(
    dict["provider.models.imageHint"],
  )
  expect(input.closest("label")?.classList.contains("min-h-10")).toBe(true)
  expect(root.textContent).toContain("Known catalog")
  expect(changes).toEqual([])
  choose(input, true)
  choose(input, false)
  expect(changes).toEqual([true, false])
  const disabled = mount(() => (
    <ModelImageInput
      modelID="EXACT"
      disabled
      onChange={() => {
        throw new Error("disabled change")
      }}
    />
  ))
  expect(checkbox(disabled, "EXACT").disabled).toBe(true)
  expect(disabled.textContent).not.toContain("Known catalog")
})

test("825 Chinese consequence is displayed by the actual component", () => {
  context.locale = "zh"
  const root = mount(() => <ModelImageInput modelID="exact" onChange={() => {}} />)
  expect(root.textContent).toContain("未开启时附件里的图片不会发给模型")
  expect(checkbox(root, "exact").checked).toBe(false)
})

test.each([undefined, true, false])(
  "825 actual new provider form persists intentional image choice %s",
  async (choice) => {
    const root = prepareCustom()
    expect(checkbox(root, "exact").checked).toBe(false)
    expect(root.textContent).toContain("Known catalog")
    if (choice !== undefined) {
      choose(checkbox(root, "exact"), true)
      if (!choice) choose(checkbox(root, "exact"), false)
    }
    submit(root)
    await settled()
    expect(context.closed).toBe(1)
    expect(context.patches).toHaveLength(1)
    expect(context.patches[0].provider?.route.models?.exact.modalities?.input).toEqual(
      choice === undefined ? undefined : choice ? ["text", "image"] : ["text"],
    )
  },
)

test.each([undefined, false])(
  "825 reconnect form displays saved choice and preserves other modalities for %s",
  async (choice) => {
    context.config = { provider: { route: preserved() } }
    const root = prepareCustom()
    expect(checkbox(root, "exact").checked).toBe(true)
    if (choice === false) choose(checkbox(root, "exact"), false)
    submit(root)
    await settled()
    expect(context.closed).toBe(1)
    const saved = context.patches[0].provider!.route.models!.exact
    expect(saved.modalities).toEqual({
      input: choice === undefined ? ["text", "audio", "pdf", "image"] : ["text", "audio", "pdf"],
      output: ["image", "text"],
    })
    expect(saved.variants).toEqual(preserved().models.exact.variants)
    expect(saved.provider).toEqual(preserved().models.exact.provider)
  },
)

test("825 actual protocol editor preserves untouched missing fields and saves only changed input", async () => {
  context.config = { provider: { route: preserved() } }
  const root = mount(() => <DialogProviderProtocol providerID="route" />)
  expect(checkbox(root, "exact").checked).toBe(true)
  expect(checkbox(root, "missing").checked).toBe(false)
  submit(root)
  await settled()
  expect(context.patches[0]).toEqual({ provider: { route: {} } })
  choose(checkbox(root, "exact"), false)
  choose(checkbox(root, "missing"), true)
  submit(root)
  await settled()
  expect(context.patches[1]).toEqual({
    provider: {
      route: {
        models: {
          exact: { modalities: { input: ["text", "audio", "pdf"] } },
          missing: { modalities: { input: ["text", "image"] } },
        },
      },
    },
  })
})

test("825 actual saved-service add form keeps new models off, disables while saving and retains previous metadata", async () => {
  context.config = { provider: { route: preserved() } }
  const root = mount(() => <ProviderModelsForm providerID="route" />)
  const input = root.querySelector<HTMLInputElement>("input:not([type=checkbox])")!
  input.value = "new-exact"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  expect(checkbox(root, "new-exact").checked).toBe(false)
  expect(checkbox(root, "exact").checked).toBe(true)
  choose(checkbox(root, "exact"), false)
  choose(checkbox(root, "new-exact"), true)
  const hold = Promise.withResolvers<void>()
  context.hold = hold.promise
  submit(root)
  await settled()
  expect(checkbox(root, "new-exact").disabled).toBe(true)
  hold.resolve()
  await settled()
  const saved = context.patches[0].provider!.route.models!
  expect(saved.exact.modalities).toEqual({ input: ["text", "audio", "pdf"], output: ["image", "text"] })
  expect(saved.exact.variants).toEqual(preserved().models.exact.variants)
  expect(saved["new-exact"].modalities?.input).toEqual(["text", "image"])
  expect(saved.missing).not.toHaveProperty("modalities")
  expect(root.querySelector('[role="alert"]')?.textContent).toBe("")
})
