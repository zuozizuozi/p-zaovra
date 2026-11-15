export * as SessionHost from "./host-state"

import { Option, Schema } from "effect"
import { SessionHostState } from "@zaovra-ai/schema/session-host-state"

export function read(value: { readonly host?: unknown }) {
  if (value.host === undefined) return
  const decoded = Schema.decodeUnknownOption(Schema.toType(SessionHostState.State))(value.host)
  if (Option.isNone(decoded)) return
  if (decoded.value.kind === "verification" && decoded.value.mode === "evidence" && !decoded.value.key) return
  const numeric =
    decoded.value.kind === "delivery" || decoded.value.kind === "budget-closing"
      ? decoded.value.receipt
      : decoded.value.kind === "facts"
        ? decoded.value.snapshot
        : decoded.value
  if (
    Object.entries(numeric).some(
      ([key, value]) =>
        typeof value === "number" &&
        (!Number.isFinite(value) ||
          (value < 0 &&
            ![
              "started",
              "deadline",
              "providerDeadline",
              "hardDeadline",
              "executionDeadline",
              "advisoryDeadline",
            ].includes(key))),
    )
  )
    return
  return decoded.value
}

export function verification(value: { readonly host?: unknown; readonly text: string }) {
  if (value.host !== undefined) return read(value)?.kind === "verification"
  return value.text.startsWith("Verification closing review:")
}

export function delivery(receipt: typeof SessionHostState.DeliveryReceipt.Type) {
  return {
    text: "Delivery contract review: " + JSON.stringify(receipt),
    host: { version: 1, kind: "delivery", receipt } as const,
  }
}

export function invalid(value: { readonly host?: unknown }) {
  return value.host !== undefined && read(value) === undefined
}

export function closing(
  value: { readonly host?: unknown; readonly text: string },
  request: string | undefined,
  source?: string,
) {
  if (value.host !== undefined) {
    const host = read(value)
    return host?.kind === "budget-closing" &&
      host.receipt.requestID === request &&
      (source === undefined || (host.receipt.sourceMessageID ?? host.receipt.requestID) === source)
      ? host.receipt
      : undefined
  }
  const prefix = "[host.run.closing] "
  if (!value.text.startsWith(prefix) || !value.text.includes(":" + request + " ")) return
  if (source !== undefined && !value.text.startsWith(prefix + source + ":" + request + " ")) return
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(
      value.text.slice(value.text.indexOf(" ", prefix.length) + 1),
    ),
  )
}

export function checkpoint(value: { readonly host?: unknown; readonly text: string }) {
  return value.host !== undefined
    ? read(value)?.kind === "budget-checkpoint"
    : value.text.startsWith("Wall-clock delivery checkpoint:")
}

export function notice(value: { readonly host?: unknown; readonly text: string }, limit: number | undefined) {
  if (value.host === undefined) return value.text.startsWith(`Session token budget notice (limit=${limit}):`)
  const host = read(value)
  return host?.kind === "budget-notice" && host.limit === limit
}
