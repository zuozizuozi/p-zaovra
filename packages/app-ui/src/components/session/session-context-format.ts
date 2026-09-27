import { DateTime } from "luxon"

export function createSessionContextFormatter(locale: string) {
  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
    },
    percent(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale) + "%"
    },
    time(value: number | string | undefined) {
      if (value === undefined) return "—"
      const timestamp = typeof value === "string" ? Date.parse(value) : value
      if (!Number.isFinite(timestamp)) return "—"
      const date = DateTime.fromMillis(timestamp)
      if (!date.isValid) return "—"
      return date.setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
  }
}
