import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createMemo, type Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = ["zaovra", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]
const popularProviderSet = new Set(popularProviders)

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
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
      all: new Map([...selected.all].filter(([id]) => id !== "zaovra-go")),
      connected: selected.connected.filter((id) => id !== "zaovra-go"),
    }
  })
  return {
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
