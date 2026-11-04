import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { Persist, persisted } from "@/utils/persist"

export function useModelService() {
  const sdk = useServerSDK()
  const [store, setStore] = persisted(
    Persist.serverGlobal(sdk().scope, "model-service"),
    createStore<{ id?: string; disconnected?: Record<string, boolean | undefined> }>({}),
  )
  return {
    current: () => store.id,
    select: (id: string) => setStore("id", id),
    disconnected: (id: string) => store.disconnected?.[id] === true,
    disconnect: (id: string, value = true) => setStore("disconnected", { ...store.disconnected, [id]: value }),
  }
}
