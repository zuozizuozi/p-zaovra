import { useLocation, useParams } from "@solidjs/router"
import { onCleanup } from "solid-js"
import { useLayout } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useDialog } from "@zaovra-ai/ui/context/dialog"

export function useSettingsDialog(defaultValue?: string) {
  const dialog = useDialog()
  const layout = useLayout()
  const sdk = useServerSDK()
  const location = useLocation()
  const params = useParams<{ id?: string }>()
  let run = 0
  let dead = false

  onCleanup(() => {
    dead = true
  })

  return () => {
    const route = layout.route()
    // Work shares the legacy home route kind, but uses the selected server SDK.
    const serverKey =
      (location.pathname === "/" ? layout.home.selection().server : route.type === "home" ? undefined : route.server) ??
      ServerConnection.key(sdk().server)
    const sessionID = route.type === "session" ? route.sessionId : params.id
    const event = new CustomEvent("zaovra:settings-open", {
      cancelable: true,
      detail: { serverKey, sessionID, defaultValue },
    })
    if (!window.dispatchEvent(event)) return
    const current = ++run
    void import("@/components/settings-v2").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => <module.DialogSettings sessionID={sessionID} defaultValue={defaultValue} />)
    })
  }
}

export function useSettingsCommand() {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog()

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: show,
    },
  ])

  return show
}
