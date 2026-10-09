import type { WebContents } from "electron"
import { getStore } from "./store"
import { queueStoreWrite } from "./store-write-queue"
import { writeStoreAtomically } from "./store-atomic"

// The IPC boundary supplies only trusted renderer targets.
export function writeStore(name: string, key: string, value: string, senderID: number, targets: WebContents[]) {
  return queueStoreWrite(name, async () => {
    const store = getStore(name)
    await writeStoreAtomically(store.path, { ...store.store, [key]: value })
    for (const target of targets) {
      if (target.id === senderID || target.isDestroyed()) continue
      target.send("store-write", { name, key, value })
    }
  })
}
