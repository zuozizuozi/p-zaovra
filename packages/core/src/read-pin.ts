export * as ReadPin from "./read-pin"

import { Effect } from "effect"
import { ReadPinNative } from "#read-pin-native"

/** Experimental native primitive. Not an authorization or a durable read receipt. */
export interface Pin {
  readonly identity: { readonly volume: string; readonly file: string }
  readonly kind: "file" | "directory"
  readonly size: bigint
  readonly snapshot: () => { readonly size: bigint; readonly written: bigint; readonly changed: bigint }
  readonly read: (maximum: number) => Uint8Array
  readonly entries: () => readonly { name: string; directory: boolean; reparse: boolean }[]
  readonly close: () => void
}

// Acquisition cannot be abandoned after a native open succeeds. Cancellation
// waits for that syscall to return, then Scope closes the acquired handles.
export const acquire = (canonical: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => ReadPinNative.open(canonical)),
    (pin) => Effect.sync(() => pin?.close()),
  )

/** Acquire only after permission; compare with the authorized original before reading. */
export const acquireStable = (canonical: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => ReadPinNative.openStable(canonical)),
    (pin) => Effect.sync(() => pin?.close()),
  )
