export const DEEP_LINK_PROTOCOLS = {
  prod: "zaovra",
  beta: "zaovra-beta",
  dev: "zaovra-dev",
} as const

export function hasDeepLinkProtocol(input: string, protocol: string) {
  return input.startsWith(`${protocol}://`)
}
