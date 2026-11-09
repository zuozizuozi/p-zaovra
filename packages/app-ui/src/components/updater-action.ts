import { formatVersion } from "@/updater"
import { createMemo } from "solid-js"
import type { UpdaterState } from "@/updater"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function updaterDetail(state: UpdaterState | undefined) {
  if (state?.status === "error") return state.message
  if (state?.status === "downloading" && state.percent !== undefined) return Math.round(state.percent) + "%"
  return ""
}

export function showPackagedUpdater(input: { platform: string; channel?: string; updater?: unknown }) {
  return input.platform === "desktop" && ["beta", "prod"].includes(input.channel ?? "") && Boolean(input.updater)
}

export function updaterAction(state: UpdaterState | undefined) {
  if (!state) return { label: "settings.updates.action.checkNow" as const }
  switch (state.status) {
    case "available":
      return { label: "settings.updates.action.download" as const, run: "download" as const }
    case "checking":
      return { label: "settings.updates.action.checking" as const }
    case "downloading":
      return { label: "settings.updates.action.downloading" as const }
    case "ready":
      return { label: "toast.update.action.installRestart" as const, run: "install" as const }
    case "installing":
      return { label: "settings.updates.action.installing" as const }
    case "disabled":
      return { label: "settings.updates.action.checkNow" as const }
    default:
      return { label: "settings.updates.action.checkNow" as const, run: "check" as const }
  }
}

export function useUpdaterAction() {
  const platform = usePlatform()
  const language = useLanguage()
  const action = createMemo(() => updaterAction(platform.updater?.state()))

  return {
    action,
    async run() {
      const run = action().run
      if (run === "install") return platform.updater?.install()
      if (run !== "check" && run !== "download") return

      const state = await platform.updater?.[run]()
      if (state?.status === "available") {
        showToast({ title: language.t("settings.updates.toast.available", { version: formatVersion(state.version) }) })
      }
      if (state?.status === "up-to-date") {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.updates.toast.latest.title"),
          description: language.t("settings.updates.toast.latest.description", {
            version: formatVersion(platform.version),
          }),
        })
      }
      if (state?.status === "error") {
        showToast({ title: language.t("common.requestFailed"), description: state.message })
      }
    },
  }
}
