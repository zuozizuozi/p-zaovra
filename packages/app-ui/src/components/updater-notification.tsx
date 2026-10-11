import { createEffect, onCleanup } from "solid-js"
import { toaster } from "@zaovra-ai/ui/toast"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function UpdaterNotification() {
  const platform = usePlatform()
  const language = useLanguage()
  let notifiedVersion: string | undefined
  createEffect(() => {
    const update = platform.updater?.state()
    if (update?.status !== "available" && update?.status !== "ready") return
    if (update.status === "available" && notifiedVersion === update.version) return
    if (update.status === "available") notifiedVersion = update.version
    const ready = update.status === "ready"
    const toastId = showToast({
      persistent: true,
      icon: "download",
      title: language.t(ready ? "toast.update.title" : "settings.updates.toast.available", { version: update.version }),
      description: ready ? language.t("toast.update.description", { version: update.version }) : undefined,
      actions: [
        {
          label: language.t(ready ? "toast.update.action.installRestart" : "settings.updates.action.download"),
          onClick: () => {
            if (ready) {
              void platform.updater?.install()
              return
            }
            void platform.updater
              ?.download()
              .then((result) => {
                if (result.status !== "error") return
                showToast({ title: language.t("common.requestFailed"), description: result.message })
              })
              .catch((error) => {
                showToast({ title: language.t("common.requestFailed"), description: String(error) })
              })
          },
        },
        { label: language.t("toast.update.action.notYet"), onClick: "dismiss" },
      ],
    })
    onCleanup(() => toaster.dismiss(toastId))
  })
  return null
}
