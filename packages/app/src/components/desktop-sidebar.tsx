import { createEffect, createMemo, createResource, For, Show } from "solid-js"
import { Icon as IconV2 } from "@zaovra-ai/ui/v2/icon"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useCommand } from "@/context/command"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { type LocalProject, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { tabHref, tabKey, type SessionTab, type Tab, useTabs } from "@/context/tabs"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { WindowsAppMenu } from "@/components/windows-app-menu"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { getProjectAvatarVariant } from "@/context/layout"
import { ProjectAvatar } from "@zaovra-ai/ui/v2/project-avatar-v2"

type ProjectGroup = {
  server: ServerConnection.Key
  project: LocalProject
  ctx: ServerCtx
}

function DesktopSessionTab(props: {
  tab: SessionTab
  active: () => boolean
  serverCtx: () => ServerCtx | undefined
  onClose: () => void
  onNavigate: () => void
}) {
  const language = useLanguage()
  const tabs = useTabs()
  const cached = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const [loaded] = createResource(
    () => {
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : undefined
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cached() ?? loaded())

  createEffect(() => {
    const value = session()
    if (value) tabs.rememberSessionInfo(props.tab, value)
  })

  return (
    <Show when={session() || tabs.info[tabKey(props.tab)]?.title}>
      <TabNavItem
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={session}
        fallbackTitle={tabs.info[tabKey(props.tab)]?.title ?? language.t("session.tab.unknown")}
        onTitleChange={(title) => {
          const value = session()
          if (value) tabs.rememberSessionInfo(props.tab, { ...value, title })
        }}
        onTitleChangeFailed={(title) => {
          const value = session()
          if (value) tabs.rememberSessionInfo(props.tab, { ...value, title })
        }}
        onClose={props.onClose}
        onNavigate={props.onNavigate}
        active={props.active()}
        forceTruncate
      />
    </Show>
  )
}

export function DesktopSidebar() {
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const tabs = useTabs()

  const groups = createMemo(() =>
    global.servers.list().flatMap((connection) => {
      const ctx = global.ensureServerCtx(connection)
      const server = ServerConnection.key(connection)
      return ctx.projects.list().map((project) => ({ server, project, ctx }))
    }),
  )
  const directory = (tab: Tab) => {
    if (tab.type === "draft") return tab.directory
    const connection = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    const ctx = connection ? global.ensureServerCtx(connection) : undefined
    return ctx?.sync.session.peek(tab.sessionId)?.directory ?? tabs.info[tabKey(tab)]?.directory
  }
  const groupForTab = (tab: Tab) => {
    const value = directory(tab)
    const candidates = groups().filter((group) => group.server === tab.server)
    if (!value) return candidates[0]
    return (
      candidates.find(
        (group) => group.project.worktree === value || group.project.sandboxes?.includes(value),
      ) ?? candidates[0]
    )
  }
  const tabsForGroup = (group: ProjectGroup) =>
    tabs.store.filter((tab) => {
      const owner = groupForTab(tab)
      return owner?.server === group.server && owner.project.worktree === group.project.worktree
    })
  const currentTab = () => {
    const route = layout.route()
    if (route.type === "draft") {
      return tabs.store.find((tab) => tab.type === "draft" && tab.draftID === route.draftID)
    }
    if (route.type !== "session") return
    return tabs.store.find(
      (tab) => tab.type === "session" && tab.server === route.server && tab.sessionId === route.sessionId,
    )
  }
  const selectProject = (group: ProjectGroup) => {
    layout.home.setSelection({ server: group.server, directory: group.project.worktree })
    if (layout.route().type !== "home") tabs.toggleHome({ home: false, current: currentTab() })
  }

  return (
    <aside
      data-component="desktop-sidebar-v2"
      class="flex h-full w-[280px] shrink-0 flex-col border-r border-v2-border-border-muted bg-v2-background-bg-deep"
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      <div class="flex h-10 shrink-0 items-center gap-1 px-2" data-tauri-drag-region>
        <Show when={["beta", "dev"].includes(import.meta.env.VITE_ZAOVRA_CHANNEL)}>
          <div class="rounded bg-v2-icon-icon-interactive px-2 py-1 font-mono text-[11px] font-semibold uppercase text-white">
            {import.meta.env.VITE_ZAOVRA_CHANNEL.toUpperCase()}
          </div>
        </Show>
        <Show when={platform.os === "windows" || platform.os === "linux"}>
          <WindowsAppMenu command={command} platform={platform} variant="v2" />
        </Show>
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm font-semibold text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
          onClick={() => command.trigger("home.toggle")}
        >
          <IconV2 name="grid-plus" size="small" />
          <span class="truncate">Zaovra</span>
        </button>
      </div>

      <div class="shrink-0 px-3 pb-3 pt-2">
        <ButtonV2
          class="w-full justify-start"
          size="normal"
          variant="ghost-muted"
          icon="edit"
          onClick={() => command.trigger("tab.new")}
        >
          {language.t("command.session.new")}
        </ButtonV2>
      </div>

      <div class="flex min-h-0 flex-1 flex-col px-3">
        <div class="flex h-8 shrink-0 items-center px-2 text-xs font-medium text-v2-text-text-faint">
          {language.t("home.projects")}
        </div>
        <nav class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4 no-scrollbar">
          <For each={groups()}>
            {(group) => (
              <section class="flex min-w-0 flex-col gap-1">
                <div class="group/project flex h-8 min-w-0 items-center gap-1 rounded-md hover:bg-v2-background-bg-layer-02">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 text-left"
                    onClick={() => selectProject(group)}
                  >
                    <span class="size-5 shrink-0">
                      <ProjectAvatar
                        fallback={displayName(group.project)}
                        src={getProjectAvatarSource(group.project.id, group.project.icon)}
                        variant={getProjectAvatarVariant(group.project.icon?.color)}
                      />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base">
                      {displayName(group.project)}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-background-bg-layer-03"
                    aria-label={group.project.expanded ? language.t("home.server.collapse") : language.t("home.server.expand")}
                    onClick={() =>
                      group.project.expanded
                        ? group.ctx.projects.collapse(group.project.worktree)
                        : group.ctx.projects.expand(group.project.worktree)
                    }
                  >
                    <IconV2 name={group.project.expanded ? "chevron-down" : "chevron-right"} size="small" />
                  </button>
                </div>

                <Show when={group.project.expanded}>
                  <div class="ml-3 flex min-w-0 flex-col gap-0.5 border-l border-v2-border-border-muted pl-2">
                    <For each={tabsForGroup(group)}>
                      {(tab) => {
                        const close = () => tabs.closeTab(tabs.store.findIndex((item) => item === tab))
                        const active = () => currentTab() === tab
                        if (tab.type === "session") {
                          return (
                            <DesktopSessionTab
                              tab={tab}
                              active={active}
                              serverCtx={() => group.ctx}
                              onClose={close}
                              onNavigate={() => tabs.select(tab)}
                            />
                          )
                        }
                        return (
                          <DraftTabItem
                            href={tabHref(tab)}
                            title={language.t("command.session.new")}
                            onClose={close}
                            onNavigate={() => tabs.select(tab)}
                            active={active()}
                          />
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </section>
            )}
          </For>
        </nav>
      </div>

      <div class="flex shrink-0 flex-col gap-1 border-t border-v2-border-border-muted p-3">
        <button
          type="button"
          class="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
          onClick={() => command.trigger("settings.open")}
        >
          <IconV2 name="settings-gear" size="small" />
          {language.t("sidebar.settings")}
        </button>
        <button
          type="button"
          class="flex h-8 items-center gap-2 rounded-md px-2 text-left text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
          onClick={() => platform.openLink("https://zaovra.com/desktop-feedback")}
        >
          <IconV2 name="help" size="small" />
          {language.t("sidebar.help")}
        </button>
      </div>
    </aside>
  )
}
