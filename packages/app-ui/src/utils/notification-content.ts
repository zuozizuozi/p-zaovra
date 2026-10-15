import type { useLanguage } from "@/context/language"

export function notificationText(value: string, limit = 160) {
  const text = Array.from(value.replace(/\s+/g, " ").trim())
  return text.length > limit ? text.slice(0, limit - 1).join("") + "…" : text.join("")
}

export function permissionDescription(permission: string, t: ReturnType<typeof useLanguage>["t"]) {
  if (permission === "doom_loop") return t("session.permission.repeatedCall")
  const key = `settings.permissions.tool.${permission}.description`
  const value = t(key as Parameters<typeof t>[0])
  return !value || value === key ? t("session.permission.requestedAccess") : value
}
