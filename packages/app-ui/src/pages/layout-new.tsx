import { createEffect, Show, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { DesktopSidebar } from "@/components/desktop-sidebar"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useCommand } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { homeProjectDirectories } from "@/pages/layout/helpers"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const desktop = () => platform.platform === "desktop"
  const navigate = useNavigate()
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const server = useServer()
  const tabs = useTabs()
  const pickDirectory = useDirectoryPicker()
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))

  command.register("new-layout", () => {
    const route = layout.route()
    const key = route.type === "home" ? layout.home.selection().server : route.server
    const connection = global.servers.list().find((item) => ServerConnection.key(item) === key) ?? server.current
    const projects = global.servers.list().flatMap((item) =>
      global
        .ensureServerCtx(item)
        .projects.list()
        .map((project) => ({ server: ServerConnection.key(item), directory: project.worktree })),
    )
    const sessions = tabs.store.filter((tab) => tab.type === "session")
    const sessionIndex = sessions.findIndex(
      (tab) => route.type === "session" && tab.server === route.server && tab.sessionId === route.sessionId,
    )
    const selected = layout.home.selection()
    const directory =
      route.type === "home"
        ? selected.directory
        : route.type === "draft"
          ? tabs.store.filter((tab) => tab.type === "draft").find((tab) => tab.draftID === route.draftID)?.directory
          : route.type === "session" && connection
            ? global.ensureServerCtx(connection).sync.session.peek(route.sessionId)?.directory
            : undefined
    const projectIndex = projects.findIndex((project) => project.server === key && project.directory === directory)
    return [
      ...([-1, 1] as const).flatMap((step) => [
        {
          id: step < 0 ? "project.previous" : "project.next",
          title: language.t(step < 0 ? "command.project.previous" : "command.project.next"),
          category: language.t("command.category.project"),
          keybind: step < 0 ? "mod+alt+arrowup" : "mod+alt+arrowdown",
          disabled: projects.length < 2,
          onSelect: () => {
            const next =
              projects[
                projectIndex < 0
                  ? step > 0
                    ? 0
                    : projects.length - 1
                  : (projectIndex + step + projects.length) % projects.length
              ]
            if (!next) return
            layout.home.setSelection(next)
            navigate("/?view=projects")
          },
        },
        {
          id: step < 0 ? "session.previous" : "session.next",
          title: language.t(step < 0 ? "command.session.previous" : "command.session.next"),
          category: language.t("command.category.session"),
          keybind: step < 0 ? "alt+arrowup" : "alt+arrowdown",
          disabled: sessions.length < 2,
          onSelect: () => {
            const next =
              sessions[
                sessionIndex < 0
                  ? step > 0
                    ? 0
                    : sessions.length - 1
                  : (sessionIndex + step + sessions.length) % sessions.length
              ]
            if (next) tabs.select(next)
          },
        },
      ]),
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        disabled: !connection || global.servers.health[ServerConnection.key(connection)]?.healthy === false,
        onSelect: () => {
          if (!connection) return
          pickDirectory({
            server: connection,
            title: language.t("command.project.open"),
            multiple: true,
            onSelect: (result) => {
              const directories = homeProjectDirectories(result)
              const directory = directories[0]
              if (!directory) return
              const ctx = global.ensureServerCtx(connection)
              directories.forEach(ctx.projects.open)
              ctx.projects.touch(directory)
              layout.home.setSelection({ server: ServerConnection.key(connection), directory })
              tabs.newDraft({ server: ServerConnection.key(connection), directory })
            },
          })
        },
      },
    ]
  })

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
        {import.meta.env.DEV && import.meta.env.VITE_ZAOVRA_DEBUG_OVERLAY === "1" && <DebugBar inline />}
        <TabsInfoPopup />
        <ToastRegion v2 />
      </div>
    </div>
  )
}
