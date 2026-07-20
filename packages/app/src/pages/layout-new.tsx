import { createEffect, Show, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { DesktopSidebar } from "@/components/desktop-sidebar"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const desktop = () => platform.platform === "desktop"
  const navigate = useNavigate()
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-row select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Show when={desktop()}>
        <DesktopSidebar />
      </Show>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <Titlebar update={update} contained={desktop()} minimal={desktop()} />
        <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
        {import.meta.env.DEV && <DebugBar inline />}
        <TabsInfoPopup />
        <ToastRegion v2 />
      </div>
    </div>
  )
}
