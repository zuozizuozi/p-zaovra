import { DEEP_LINK_PROTOCOLS, hasDeepLinkProtocol } from "../../deep-link-protocol"

export const deepLinkEvent = "zaovra:deep-link"

const channel = import.meta.env.VITE_ZAOVRA_CHANNEL
const protocol = DEEP_LINK_PROTOCOLS[channel === "beta" ? "beta" : channel === "dev" ? "dev" : "prod"]

const parseUrl = (input: string, scheme: string) => {
  if (!hasDeepLinkProtocol(input, scheme)) return
  if (typeof URL.canParse === "function" && !URL.canParse(input)) return
  try {
    return new URL(input)
  } catch {
    return
  }
}

export const parseDeepLink = (input: string, scheme = protocol) => {
  const url = parseUrl(input, scheme)
  if (!url) return
  if (url.hostname !== "open-project") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  return directory
}

export const parseNewSessionDeepLink = (input: string, scheme = protocol) => {
  const url = parseUrl(input, scheme)
  if (!url) return
  if (url.hostname !== "new-session") return
  const directory = url.searchParams.get("directory")
  if (!directory) return
  const prompt = url.searchParams.get("prompt") || undefined
  if (!prompt) return { directory }
  return { directory, prompt }
}

export const collectOpenProjectDeepLinks = (urls: string[]) =>
  urls.map((url) => parseDeepLink(url)).filter((directory): directory is string => !!directory)

export const collectNewSessionDeepLinks = (urls: string[]) =>
  urls
    .map((url) => parseNewSessionDeepLink(url))
    .filter((link): link is { directory: string; prompt?: string } => !!link)

type ZaovraWindow = Window & {
  __ZAOVRA__?: {
    deepLinks?: string[]
  }
}

export const drainPendingDeepLinks = (target: ZaovraWindow) => {
  const pending = target.__ZAOVRA__?.deepLinks ?? []
  if (pending.length === 0) return []
  if (target.__ZAOVRA__) target.__ZAOVRA__.deepLinks = []
  return pending
}
