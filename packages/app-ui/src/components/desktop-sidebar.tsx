import { createEffect, createMemo, createResource, For, Show, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Icon as IconV2 } from "@zaovra-ai/ui/v2/icon"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useCommand } from "@/context/command"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { type LocalProject, useLayout } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { tabHref, tabKey, type SessionTab, type Tab, useTabs } from "@/context/tabs"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { displayName } from "@/pages/layout/helpers"
import { ProjectGlyph } from "@/components/project-glyph"
import { Wordmark } from "@zaovra-ai/ui/logo"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { desktopProjectGroup } from "./desktop-project-group"
import type { PromptSession } from "@/context/prompt-state"

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
        conversationIcon
      />
    </Show>
  )
}

export function DesktopSidebar() {
  const navigate = useNavigate()
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const dialog = useDialog()
  const [view, setView] = createStore({ expanded: "" })
  const groupKey = (group: ProjectGroup) => `${group.server}:${group.project.worktree}`

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
  const groupForTab = (tab: Tab) => desktopProjectGroup(groups(), tab.server, directory(tab))
  const tabsForGroup = (group: ProjectGroup) =>
    tabs.store.filter((tab) => {
      if (tab.type === "draft" && tab !== currentTab()) {
        const prompt = tabs.stateValue<PromptSession>(tab, "prompt")
        if (prompt?.ready() && !prompt.dirty() && prompt.context.items().length === 0) return false
      }
      const owner = groupForTab(tab)
      return owner?.server === group.server && owner.project.worktree === group.project.worktree
    })
  const recent = createMemo(() =>
    tabs.store
      .filter((tab): tab is SessionTab => tab.type === "session")
      .filter((tab) => {
        const group = groupForTab(tab)
        return !group || view.expanded !== groupKey(group)
      })
      .map((tab) => {
        const connection = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
        const ctx = connection ? global.ensureServerCtx(connection) : undefined
        return { tab, ctx, updated: ctx?.sync.session.peek(tab.sessionId)?.time.updated ?? 0 }
      })
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 5),
  )
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
    // Changing the selection synchronously expands the active group below.
    // Decide the user's toggle before that effect runs, not after it.
    const expanded = view.expanded === groupKey(group) ? "" : groupKey(group)
    layout.home.setSelection({ server: group.server, directory: group.project.worktree })
    setView("expanded", expanded)
    if (!currentTab()) navigate("/")
  }
  const activeGroup = createMemo(() => {
    const tab = currentTab()
    if (tab) return groupForTab(tab)
    const selection = layout.home.selection()
    return groups().find((group) => group.server === selection.server && group.project.worktree === selection.directory)
  })
  createEffect(
    on(
      () => activeGroup() && groupKey(activeGroup()!),
      (key) => {
        if (key) setView("expanded", key)
      },
    ),
  )

  return (
    <aside
      data-component="desktop-sidebar-v2"
      class="flex h-full w-[280px] shrink-0 flex-col bg-v2-background-bg-deep"
      aria-label={language.t("sidebar.nav.projectsAndSessions")}
    >
      <div class="flex h-10 shrink-0 items-center gap-1 px-2" data-tauri-drag-region>
        <div class="flex min-w-0 flex-1 items-center gap-2 px-2 text-sm font-semibold text-v2-text-text-base">
          <Wordmark class="w-28 shrink-0" />
        </div>
        <button
          type="button"
          class="flex size-8 items-center justify-center rounded-lg hover:bg-v2-background-bg-layer-02"
          aria-label={language.t("command.palette")}
          onClick={() => command.trigger("command.palette")}
        >
          <IconV2 name="magnifying-glass" size="small" />
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
              <section
                data-slot="sidebar-project"
                data-current={activeGroup() && groupKey(activeGroup()!) === groupKey(group)}
                class="flex min-w-0 flex-col gap-1"
              >
                <div class="group/project flex h-8 min-w-0 items-center gap-1 rounded-md hover:bg-v2-background-bg-layer-02">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 text-left"
                    onClick={() => selectProject(group)}
                    title={group.project.worktree}
                  >
                    <span class="size-5 shrink-0">
                      <ProjectGlyph project={group.project} />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-[13px] font-normal text-v2-text-text-base">
                      {displayName(group.project)}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-slot="project-action"
                    aria-label={language.t("command.session.new")}
                    class="flex size-6 items-center justify-center"
                    onClick={() => {
                      layout.home.setSelection({ server: group.server, directory: group.project.worktree })
                      void tabs.newDraft({ server: group.server, directory: group.project.worktree })
                    }}
                  >
                    <IconV2 name="plus" size="small" />
                  </button>
                  <button
                    type="button"
                    data-slot="project-action"
                    class="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-background-bg-layer-03"
                    aria-label={
                      view.expanded === groupKey(group)
                        ? language.t("home.server.collapse")
                        : language.t("home.server.expand")
                    }
                    onClick={() => selectProject(group)}
                  >
                    <IconV2 name={view.expanded === groupKey(group) ? "chevron-down" : "chevron-right"} size="small" />
                  </button>
                  <MenuV2 modal={false} placement="bottom-end">
                    <MenuV2.Trigger
                      data-slot="project-action"
                      class="flex size-6 shrink-0 items-center justify-center"
                      aria-label={language.t("common.moreOptions")}
                    >
                      <IconV2 name="outline-dots" size="small" />
                    </MenuV2.Trigger>
                    <MenuV2.Portal>
                      <MenuV2.Content>
                        <MenuV2.Item
                          onSelect={async () => {
                            const connection = global.servers
                              .list()
                              .find((item) => ServerConnection.key(item) === group.server)
                            if (!connection) return
                            const { DialogEditProjectV2 } = await import("@/components/dialog-edit-project-v2")
                            void dialog.show(() => <DialogEditProjectV2 project={group.project} server={connection} />)
                          }}
                        >
                          {language.t("dialog.project.edit.title")}
                        </MenuV2.Item>
                        <MenuV2.Item onSelect={() => group.ctx.projects.close(group.project.worktree)}>
                          {language.t("common.close")}
                        </MenuV2.Item>
                      </MenuV2.Content>
                    </MenuV2.Portal>
                  </MenuV2>
                </div>

                <Show when={view.expanded === groupKey(group)}>
                  <div class="flex min-w-0 flex-col gap-0.5">
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
          <Show when={recent().length}>
            <section data-slot="sidebar-recent" class="mt-3 flex flex-col gap-1">
              <div class="px-2 py-2 text-xs text-v2-text-text-faint">
                {language.t("sidebar.project.recentSessions")}
              </div>
              <For each={recent()}>
                {(item) => (
                  <DesktopSessionTab
                    tab={item.tab}
                    active={() => currentTab() === item.tab}
                    serverCtx={() => item.ctx}
                    onClose={() => tabs.closeTab(tabs.store.findIndex((tab) => tab === item.tab))}
                    onNavigate={() => tabs.select(item.tab)}
                  />
                )}
              </For>
            </section>
          </Show>
        </nav>
      </div>
    </aside>
  )
}
