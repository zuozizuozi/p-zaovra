import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { refreshSavedProviderModels } from "@/utils/saved-provider-models"
import { selectProviderCatalog } from "./provider-catalog"
import { directoryKey } from "@/context/global-sync/utils"

export const popularProviders = ["zaovra", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]
const popularProviderSet = new Set(popularProviders)

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const sdk = useServerSDK()
  const [state, setState] = createStore({ refreshing: false, discoveryError: false })
  const alive = { value: true }
  onCleanup(() => {
    alive.value = false
  })
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const providers = createMemo(() => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    const selected = directory
      ? selectProviderCatalog({
          explicit: true,
          directory: value,
          global: serverSync().data.provider,
          catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
        })
      : selectProviderCatalog({
          explicit: false,
          directory: value,
          catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
          global: serverSync().data.provider,
        })
    // The V2 catalog already applies credentials, provider policy and model filters.
    // Re-filtering through the legacy preference cache can hide valid models after
    // a key is saved or when native V2 config has no legacy provider projection.
    return {
      ...selected,
      all: new Map([...selected.all].filter(([id]) => id !== "zaovra-go" && id !== "zaovra")),
      connected: selected.connected.filter((id) => id !== "zaovra-go" && id !== "zaovra"),
    }
  })
  return {
    loading: () => {
      if (state.refreshing) return true
      const value = dir()
      return value ? serverSync().child(value)[0].provider_loading : serverSync().data.provider_loading
    },
    error: () => {
      if (state.discoveryError) return true
      const value = dir()
      return value ? serverSync().child(value)[0].provider_error : serverSync().data.provider_error
    },
    refresh: async (options?: { discover?: boolean }) => {
      if (state.refreshing) return
      const target = serverSync()
      const server = sdk()
      const directory = dir()
      const current = () => alive.value && serverSync() === target && sdk() === server && dir() === directory
      setState({ refreshing: true, discoveryError: false })
      try {
        if (options?.discover !== false) {
          // These are global saved services. Never persist a project-specific
          // provider's model list into the user's global configuration.
          const ids = target.data.provider.connected.filter(
            (id) => !!target.data.config.provider?.[id]?.options?.baseURL,
          )
          const results = await Promise.allSettled(
            ids.map((providerID) =>
              refreshSavedProviderModels({
                client: server.client,
                providerID,
                config: () => target.data.config,
                save: target.updateConfig,
                current,
              }),
            ),
          )
          if (!current()) return
          setState(
            "discoveryError",
            results.some((result) => result.status === "rejected"),
          )
        }
        if (!current()) return
        await target.queryClient.refetchQueries({
          queryKey: target.queryOptions.providers(directory ? directoryKey(directory) : null).queryKey,
          exact: true,
          type: "active",
        })
      } finally {
        if (alive.value) setState("refreshing", false)
      }
    },
    all: () => providers().all,
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "zaovra" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
    },
  }
}
