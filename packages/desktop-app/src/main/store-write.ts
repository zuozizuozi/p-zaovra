import type { WebContents } from "electron"
import { getStore } from "./store"

// The IPC boundary supplies only trusted renderer targets.
export function writeStore(name: string, key: string, value: string, senderID: number, targets: WebContents[]) {
  getStore(name).set(key, value)
  for (const target of targets) {
    if (target.id === senderID || target.isDestroyed()) continue
    target.send("store-write", { name, key, value })
  }
}
