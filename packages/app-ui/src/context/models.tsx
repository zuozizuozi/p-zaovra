import { groupModelChoices } from "./model-choice"
import { modelSource } from "@/utils/model-source"
import { type Accessor, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@zaovra-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { providerModelType, type ProviderModelType } from "@/provider-discovery"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
  types?: Record<string, ProviderModelType | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> } = {}) => {
    const providers = useProviders(props.directory)

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const available = createMemo(() =>
      providers
        .connected()
        .filter((p) => modelSource(p) === "own")
        .flatMap((p) =>
          Object.values(p.models).map((m) => ({
            ...m,
            provider: p,
          })),
        ),
    )

    const choices = createMemo(() => groupModelChoices(available()))
    const list = createMemo(() =>
      choices().map((m) => ({
        ...m,
        name: m.name
          .replace("(latest)", "")
          .replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "")
          .trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => {
      const exact = list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)
      if (exact) return exact
      const base = list().find(
        (m) => m.provider.id === key.providerID && Object.values(m.reasoningModels ?? {}).includes(key.modelID),
      )
      return base ? { ...base, id: key.modelID } : undefined
    }
    const type = (key: ModelKey): ProviderModelType => {
      const item = find(key)
      return (
        store.types?.[modelKey(key)] ??
        (item ? providerModelType(item, item) : providerModelType({ id: key.modelID })) ??
        "chat"
      )
    }
    const setType = (key: ModelKey, type: ProviderModelType | undefined) => {
      if (!store.types) {
        setStore("types", { [modelKey(key)]: type })
        return
      }
      setStore("types", modelKey(key), type)
    }

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => !!find(model)

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    const [recentModels] = createResource(
      async () => {
        const recent = store.recent
        await ready.promise
        return recent
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      catalog: { loading: providers.loading, error: providers.error, refresh: providers.refresh },
      list,
      find,
      type,
      setType,
      typeOverride: (key: ModelKey) => store.types?.[modelKey(key)],
      visible,
      setVisibility,
      recent: {
        list: () => recentModels()!,
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
