export * as ReadPinNative from "./read-pin-native.node"

import type { ReadPin } from "./read-pin"

export async function open(_canonical: string): Promise<ReadPin.Pin | undefined> {
  return undefined
}
