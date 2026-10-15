export const LOCALES = ["en", "zh"] as const

export type Locale = (typeof LOCALES)[number]

export const LOCALE_COOKIE = "zaovra_locale" as const
export const LOCALE_HEADER = "x-zaovra-locale" as const

// Locale prefixes that were published before the site narrowed to English and Simplified Chinese.
export const RETIRED_LOCALES = ["zht", "ko", "de", "es", "fr", "it", "da", "ja", "pl", "ru", "uk", "ar", "no", "br", "th", "tr"]

function fix(pathname: string) {
  if (pathname.startsWith("/")) return pathname
  return `/${pathname}`
}

const LABEL = {
  en: "English",
  zh: "简体中文",
} satisfies Record<Locale, string>

const TAG = {
  en: "en",
  zh: "zh-Hans",
} satisfies Record<Locale, string>

export function parseLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

export function fromPathname(pathname: string) {
  return parseLocale(fix(pathname).split("/")[1])
}

export function strip(pathname: string) {
  const locale = fromPathname(pathname)
  if (!locale) return fix(pathname)

  const next = fix(pathname).slice(locale.length + 1)
  if (!next) return "/"
  if (next.startsWith("/")) return next
  return `/${next}`
}

export function route(locale: Locale, pathname: string) {
  const next = strip(pathname)
  if (next.startsWith("/auth")) return next
  if (next.startsWith("/workspace")) return next
  if (locale === "en") return next
  if (next === "/") return `/${locale}`
  return `/${locale}${next}`
}

export function label(locale: Locale) {
  return LABEL[locale]
}

export function tag(locale: Locale) {
  return TAG[locale]
}

export function dir(_locale: Locale) {
  return "ltr" as const
}

function match(input: string): Locale | null {
  const value = input.trim().toLowerCase()
  if (!value) return null

  if (value.startsWith("zh")) return "zh"
  if (value.startsWith("en")) return "en"
  return null
}

export function detectFromLanguages(languages: readonly string[]) {
  for (const language of languages) {
    const locale = match(language)
    if (locale) return locale
  }
  return "en" satisfies Locale
}

export function detectFromAcceptLanguage(header: string | null) {
  if (!header) return "en" satisfies Locale

  const items = header
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const parts = raw.split(";").map((x) => x.trim())
      const lang = parts[0] ?? ""
      const q = parts
        .slice(1)
        .find((x) => x.startsWith("q="))
        ?.slice(2)
      return {
        lang,
        q: q ? Number.parseFloat(q) : 1,
      }
    })
    .sort((a, b) => b.q - a.q)

  for (const item of items) {
    if (!item.lang || item.lang === "*") continue
    const locale = match(item.lang)
    if (locale) return locale
  }

  return "en" satisfies Locale
}

export function localeFromCookieHeader(header: string | null) {
  if (!header) return null

  const raw = header
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(`${LOCALE_COOKIE}=`.length)

  if (!raw) return null
  return parseLocale(decodeURIComponent(raw))
}

export function localeFromRequest(request: Request) {
  const fromHeader = parseLocale(request.headers.get(LOCALE_HEADER))
  if (fromHeader) return fromHeader

  const fromPath = fromPathname(new URL(request.url).pathname)
  if (fromPath) return fromPath

  return (
    localeFromCookieHeader(request.headers.get("cookie")) ??
    detectFromAcceptLanguage(request.headers.get("accept-language"))
  )
}

export function cookie(locale: Locale) {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function clearCookie() {
  return `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
