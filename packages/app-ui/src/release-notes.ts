import beta12 from "./release-notes/0.1.1-beta.12.json"
import current from "./release-notes/current.json"

export type ReleaseHighlight = {
  title: string
  description: string
}

const releases: Record<string, { zh: ReleaseHighlight[]; en: ReleaseHighlight[] }> = {
  "0.1.1-beta.12": beta12,
  ...(current.version ? { [current.version]: current } : {}),
}

export function releaseNotes(version: string | undefined, locale: string) {
  if (!version) return []
  return releases[version]?.[locale.startsWith("zh") ? "zh" : "en"] ?? []
}

export function shouldShowReleaseNotes(
  previous: string | undefined,
  current: string | undefined,
  enabled: boolean,
  count: number,
) {
  return !!previous && !!current && previous !== current && enabled && count > 0
}
