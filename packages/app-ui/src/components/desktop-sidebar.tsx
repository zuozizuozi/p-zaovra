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
import { usePlatform } from "@/context/platform"
import { fileManagerApp } from "@/utils/file-manager"
import { showToast } from "@/utils/toast"
import { createImeKeyOwnership } from "@/utils/ime-key-ownership"
import { SidebarSessionActions } from "./sidebar-session-actions"
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
  pinned?: boolean
}) {
  const language = useLanguage()
  const tabs = useTabs()
  const layout = useLayout()
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
    if (props.pinned && value?.time.archived) {
      layout.pins.remove(props.tab.server, props.tab.sessionId)
      return
    }
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
        actions={(rename) =>
          session() && props.serverCtx() ? (
            <SidebarSessionActions
              session={session()!}
              server={props.tab.server}
              ctx={props.serverCtx()!}
              rename={rename}
            />
          ) : undefined
        }
      />
    </Show>
  )
}

export function DesktopSidebar() {
  const ime = createImeKeyOwnership()
  const navigate = useNavigate()
  const command = useCommand()
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const tabs = useTabs()
  const platform = usePlatform()
  const [view, setView] = createStore({
    menuProject: "",
    editingProject: "",
    projectTitle: "",
    savingProject: false,
    collapsed: {} as Record<string, boolean>,
    loadErrors: {} as Record<string, boolean>,
  })
  const connection = (group: ProjectGroup) =>
    global.servers.list().find((item) => ServerConnection.key(item) === group.server)
  const renameProject = async (group: ProjectGroup) => {
    if (view.editingProject !== groupKey(group) || view.savingProject) return
    const name = view.projectTitle.trim()
    if (!name || name === displayName(group.project, language)) {
      setView("editingProject", "")
      return
    }
    setView("savingProject", true)
    await (
      group.project.id && group.project.id !== "global"
        ? group.ctx.sdk
            .createClient({ directory: group.project.worktree, throwOnError: true })
            .project.update({ projectID: group.project.id, directory: group.project.worktree, name })
        : Promise.resolve(group.ctx.sync.project.meta(group.project.worktree, { name }))
    )
      .then(() => setView("editingProject", ""))
      .catch((error: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : undefined,
        }),
      )
      .finally(() => setView("savingProject", false))
  }
  const groupKey = (group: ProjectGroup) => `${group.server}:${group.project.worktree}`
  const expanded = (group: ProjectGroup) => !view.collapsed[groupKey(group)]
  const loaded = new Set<string>()

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
      if (tab.type === "session" && layout.pins.has(tab.server, tab.sessionId)) return false
      if (tab.type === "draft" && tab !== currentTab()) {
        const prompt = tabs.stateValue<PromptSession>(tab, "prompt")
        if (prompt?.ready() && !prompt.dirty() && prompt.context.items().length === 0) return false
      }
      const owner = groupForTab(tab)
      return owner?.server === group.server && owner.project.worktree === group.project.worktree
    })
  const groupSessions = (group: ProjectGroup) => {
    const open = new Set(tabsForGroup(group).flatMap((tab) => (tab.type === "session" ? [tab.sessionId] : [])))
    return [...new Set([group.project.worktree, ...(group.project.sandboxes ?? [])])]
      .flatMap((directory) => group.ctx.sync.child(directory, { bootstrap: false })[0].session)
      .filter((session) => !session.parentID && !session.time.archived && !open.has(session.id))
      .filter((session) => !layout.pins.has(group.server, session.id))
      .filter((session) => desktopProjectGroup(groups(), group.server, session.directory) === group)
      .filter((session, index, all) => all.findIndex((item) => item.id === session.id) === index)
      .toSorted((a, b) => b.time.updated - a.time.updated)
  }
  const loadGroup = (group: ProjectGroup, more = false) => {
    const key = groupKey(group)
    setView("loadErrors", key, false)
    void Promise.all(
      [...new Set([group.project.worktree, ...(group.project.sandboxes ?? [])])].map((directory) =>
        group.ctx.sync.project.loadSessions(
          directory,
          more ? { limit: group.ctx.sync.child(directory, { bootstrap: false })[0].limit + 20 } : undefined,
        ),
      ),
    ).catch(() => setView("loadErrors", key, true))
  }
  createEffect(() => {
    groups()
      .filter(expanded)
      .forEach((group) => {
        const key = groupKey(group)
        if (loaded.has(key)) return
        loaded.add(key)
        loadGroup(group)
      })
  })
  const recent = createMemo(() =>
    tabs.store
      .filter((tab): tab is SessionTab => tab.type === "session")
      .filter((tab) => !layout.pins.has(tab.server, tab.sessionId))
      .filter((tab) => {
        const group = groupForTab(tab)
        return !group
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
  const pinned = createMemo(() =>
    layout.pins.list().flatMap((pin) => {
      const connection = global.servers.list().find((item) => ServerConnection.key(item) === pin.server)
      if (!connection) return []
      return [
        {
          tab: { type: "session", server: pin.server, sessionId: pin.sessionID } as SessionTab,
          ctx: global.ensureServerCtx(connection),
        },
      ]
    }),
  )
  const selectProject = (group: ProjectGroup) => {
    layout.home.setSelection({ server: group.server, directory: group.project.worktree })
    setView("collapsed", groupKey(group), false)
    navigate("/")
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
        if (key) setView("collapsed", key, false)
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
          onClick={() => {
            const group = activeGroup()
            if (!group) return command.trigger("tab.new")
            void tabs.newDraft({ server: group.server, directory: group.project.worktree })
          }}
        >
          {language.t("command.session.new")}
        </ButtonV2>
        <Show when={activeGroup()}>
          {(group) => (
            <p data-slot="new-session-project" class="px-2 pt-1 text-xs text-v2-text-text-faint truncate">
              {language.t("sidebar.newSessionProject", { project: displayName(group().project, language) })}
            </p>
          )}
        </Show>
      </div>

      <div class="flex min-h-0 flex-1 flex-col px-3">
        <Show when={pinned().length}>
          <section data-slot="sidebar-pinned" class="mb-3 max-h-48 shrink-0 overflow-y-auto">
            <div class="px-2 py-2 text-xs font-medium text-v2-text-text-faint">
              {language.t("sidebar.session.pinned")}
            </div>
            <For each={pinned()}>
              {(item) => (
                <DesktopSessionTab
                  pinned
                  tab={item.tab}
                  active={() => currentTab()?.type === "session" && tabKey(currentTab()!) === tabKey(item.tab)}
                  serverCtx={() => item.ctx}
                  onClose={() => layout.pins.remove(item.tab.server, item.tab.sessionId)}
                  onNavigate={() => tabs.select(item.tab)}
                />
              )}
            </For>
          </section>
        </Show>
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
                <MenuV2
                  open={view.menuProject === groupKey(group)}
                  onOpenChange={(open) => setView("menuProject", open ? groupKey(group) : "")}
                  modal={false}
                  placement="bottom-end"
                >
                  <div
                    class="group/project flex h-8 min-w-0 items-center gap-1 rounded-md hover:bg-v2-background-bg-layer-02"
                    onContextMenu={(event) => {
                      if (view.editingProject === groupKey(group)) return
                      event.preventDefault()
                      event.stopPropagation()
                      setView("menuProject", groupKey(group))
                    }}
                  >
                    <Show
                      when={view.editingProject === groupKey(group)}
                      fallback={
                        <>
                          <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-2 px-2 text-left"
                            onClick={() => selectProject(group)}
                            title={group.project.worktree}
                            data-slot="project-heading"
                          >
                            <span class="size-5 shrink-0">
                              <ProjectGlyph project={group.project} />
                            </span>
                            <span class="min-w-0 flex-1 truncate text-[13px] font-normal text-v2-text-text-base">
                              {displayName(group.project, language)}
                            </span>
                          </button>
                        </>
                      }
                    >
                      <input
                        data-action="project-rename"
                        aria-label={language.t("common.rename")}
                        class="mx-2 min-w-0 flex-1 rounded border border-v2-border-border-focus bg-transparent px-1 text-[13px] text-v2-text-text-base outline-none"
                        value={view.projectTitle}
                        disabled={view.savingProject}
                        ref={(input) =>
                          queueMicrotask(() => {
                            input.focus()
                            input.select()
                          })
                        }
                        onInput={(event) => setView("projectTitle", event.currentTarget.value)}
                        onCompositionStart={ime.start}
                        onCompositionEnd={ime.end}
                        onKeyDown={(event) => {
                          if (ime.owns(event)) return
                          event.stopPropagation()
                          if (event.key === "Escape") {
                            event.preventDefault()
                            setView("editingProject", "")
                            return
                          }
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void renameProject(group)
                          }
                        }}
                        onBlur={() => void renameProject(group)}
                      />
                    </Show>
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
                      aria-expanded={expanded(group)}
                      aria-label={
                        expanded(group) ? language.t("home.server.collapse") : language.t("home.server.expand")
                      }
                      onClick={() => setView("collapsed", groupKey(group), expanded(group))}
                    >
                      <IconV2 name={expanded(group) ? "chevron-down" : "chevron-right"} size="small" />
                    </button>
                    <MenuV2.Trigger
                      data-slot="project-action"
                      class="hover-reveal mr-1 flex size-6 shrink-0 items-center justify-center group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100"
                      aria-label={language.t("common.moreOptions")}
                    >
                      <IconV2 name="outline-dots" size="small" />
                    </MenuV2.Trigger>
                    <MenuV2.Portal>
                      <MenuV2.Content
                        class="w-56"
                        onCloseAutoFocus={(event) => {
                          if (view.editingProject === groupKey(group)) event.preventDefault()
                        }}
                      >
                        <MenuV2.Item
                          onSelect={() => {
                            layout.home.setSelection({ server: group.server, directory: group.project.worktree })
                            void tabs.newDraft({ server: group.server, directory: group.project.worktree })
                          }}
                        >
                          {language.t("command.session.new")}
                        </MenuV2.Item>
                        <MenuV2.Item
                          onSelect={() =>
                            setView({
                              editingProject: groupKey(group),
                              projectTitle: displayName(group.project, language),
                            })
                          }
                        >
                          {language.t("common.rename")}
                        </MenuV2.Item>
                        <Show when={platform.openPath && ServerConnection.local(connection(group))}>
                          <MenuV2.Item
                            onSelect={() =>
                              void platform.openPath?.(group.project.worktree).catch((error: unknown) =>
                                showToast({
                                  title: language.t("common.requestFailed"),
                                  description: error instanceof Error ? error.message : undefined,
                                }),
                              )
                            }
                          >
                            {language.t(fileManagerApp(platform.os ?? "unknown").actionLabel)}
                          </MenuV2.Item>
                        </Show>
                        <MenuV2.Separator />
                        <MenuV2.Item onSelect={() => group.ctx.projects.close(group.project.worktree)}>
                          {language.t("sidebar.project.remove")}
                        </MenuV2.Item>
                      </MenuV2.Content>
                    </MenuV2.Portal>
                  </div>
                </MenuV2>

                <Show when={expanded(group)}>
                  <div
                    class="ml-3 flex min-w-0 flex-col gap-0.5 border-l border-border-weak-base pl-2"
                    data-slot="project-conversations"
                  >
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
                    <For each={groupSessions(group)}>
                      {(session) => {
                        const tab: SessionTab = { type: "session", server: group.server, sessionId: session.id }
                        return (
                          <TabNavItem
                            href={tabHref(tab)}
                            server={group.server}
                            session={() => session}
                            active={false}
                            forceTruncate
                            conversationIcon
                            onClose={() => {}}
                            onNavigate={() => {
                              tabs.rememberSessionInfo(tab, session)
                              tabs.select(tab)
                            }}
                            actions={(rename) => (
                              <SidebarSessionActions
                                session={session}
                                server={group.server}
                                ctx={group.ctx}
                                rename={rename}
                              />
                            )}
                          />
                        )
                      }}
                    </For>
                    <Show when={view.loadErrors[groupKey(group)]}>
                      <button type="button" class="p-2 text-xs text-text-weak" onClick={() => loadGroup(group)}>
                        {language.t("sidebar.sessionsRetry")}
                      </button>
                    </Show>
                    <Show
                      when={
                        group.ctx.sync.child(group.project.worktree, { bootstrap: false })[0].sessionTotal >
                        group.ctx.sync.child(group.project.worktree, { bootstrap: false })[0].session.length
                      }
                    >
                      <button
                        type="button"
                        class="p-2 text-left text-xs text-text-weak"
                        onClick={() => loadGroup(group, true)}
                      >
                        {language.t("common.loadMore")}
                      </button>
                    </Show>
                  </div>
                </Show>
              </section>
            )}
          </For>
          <Show when={recent().length}>
            <section data-slot="sidebar-recent" class="mt-3 flex flex-col gap-1">
              <div class="px-2 py-2 text-xs text-v2-text-text-faint">{language.t("sidebar.otherSessions")}</div>
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
