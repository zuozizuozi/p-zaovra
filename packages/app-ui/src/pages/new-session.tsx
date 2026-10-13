import { displayName } from "@/pages/layout/helpers"
import { Show, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLocation, useSearchParams } from "@solidjs/router"
import { Tooltip } from "@zaovra-ai/ui/tooltip"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { Icon as IconV2 } from "@zaovra-ai/ui/v2/icon"
import { TooltipV2 } from "@zaovra-ai/ui/v2/tooltip-v2"
import { NewSessionDesignView } from "@/components/session"
import { PromptInputV2Composer, usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { StatusPopoverV2 } from "@/components/status-popover"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  createPromptProjectController,
} from "@/components/prompt-project-selector"
import { useComments } from "@/context/comments"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { createPromptInputController, createPromptProjectControls } from "@/pages/session/composer"
import { useSessionKey } from "@/pages/session/session-layout"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useCommand } from "@/context/command"
import { useProviders } from "@/hooks/use-providers"
import { useSettingsCommand } from "@/components/settings-dialog"
import { Persist, persisted } from "@/utils/persist"
import createPresence from "solid-presence"
import { useLocal } from "@/context/local"
import { createPromptModelSelection } from "@/pages/session/composer/prompt-model-selection"

const workspaceBarEnabled = import.meta.env.VITE_ZAOVRA_CHANNEL !== "prod"
const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000
const providerTipExitDuration = 250

/**
 * The `/new-session` draft page. Unlike `session.tsx`, this only renders the prompt
 * composer for a brand-new session — no terminal, review pane, file tree, or message
 * timeline. Submitting promotes the draft into a real session (see prompt-input/submit).
 */
export default function NewSessionPage() {
  const prompt = usePrompt()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const comments = useComments()
  const language = useLanguage()
  const settings = useSettings()
  const dialog = useDialog()
  const command = useCommand()
  const providers = useProviders(() => sdk().directory)
  const openProviders = () => {
    void import("@/components/dialog-connect-provider").then(({ DialogConnectProvider }) => {
      void dialog.show(() => <DialogConnectProvider directory={() => sdk().directory} />)
    })
  }
  useSettingsCommand()
  const route = useSessionKey()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const local = useLocal()
  const model = createPromptModelSelection({ agent: local.agent.current })

  useComposerCommands({ model })

  const inputController = createPromptInputController({
    sessionKey: route.sessionKey,
    sessionID: () => route.params.id,
    queryOptions: serverSync().queryOptions,
    model,
  })
  const projectControls = createPromptProjectControls()

  const [store, setStore] = createStore<{ worktree?: string }>({})
  const rightMount = useTitlebarRightMount()

  const showWorkspaceBar = createMemo(
    () => workspaceBarEnabled && sync().project?.vcs === "git" && (sync().project?.sandboxes?.length ?? 0) > 0,
  )
  const newSessionWorktree = createMemo(() => {
    if (!showWorkspaceBar()) return "main"
    if (store.worktree) return store.worktree
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const localBranch = createMemo(() => serverSync().child(projectRoot())[0].vcs?.branch)
  const selectedBranch = createMemo(() => {
    const worktree = newSessionWorktree()
    if (worktree === "main" || worktree === "create") return localBranch()
    return serverSync().child(worktree)[0].vcs?.branch ?? localBranch()
  })
  const promptInputV2Controller = usePromptInputV2Controller({
    get controls() {
      return inputController()
    },
    get newSessionWorktree() {
      return newSessionWorktree()
    },
    onNewSessionWorktreeReset: () => setStore("worktree", undefined),
    onSubmit: () => comments.clear(),
  })
  const projectController = createPromptProjectController({
    controls: projectControls,
    onDone: promptInputV2Controller.restoreFocus,
  })

  command.register("prompt-navigation", () =>
    location.pathname !== "/new-session"
      ? []
      : [
          {
            id: "command.palette",
            title: language.t("command.palette"),
            hidden: true,
            onSelect: async () => {
              const { DialogSelectFile } = await import("@/components/dialog-select-file")
              void dialog.show(() => <DialogSelectFile />)
            },
          },
          {
            id: "input.focus",
            title: language.t("command.input.focus"),
            category: language.t("command.category.view"),
            keybind: "ctrl+l",
            onSelect: () => promptInputV2Controller.restoreFocus(),
          },
        ],
  )

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  createEffect(() => {
    if (!prompt.ready()) return
    promptInputV2Controller.restoreFocus()
  })

  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Show when={settings.visibility.status()}>
              <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                <StatusPopoverV2 />
              </Tooltip>
            </Show>
          </Portal>
        )}
      </Show>
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <div class="@container relative flex flex-col min-h-0 h-full flex-1">
          <div class="flex-1 min-h-0 overflow-hidden rounded-[10px]">
            <NewSessionDesignView
              heading={
                projectController.selected()
                  ? language.t("session.new.projectTitle", { project: displayName(projectController.selected()!) })
                  : undefined
              }
            >
              <div data-slot="new-session-task" class={NEW_SESSION_CONTENT_WIDTH}>
                <div class="flex flex-col" classList={{ "gap-8": showWorkspaceBar(), "gap-3": !showWorkspaceBar() }}>
                  <Show when={projectController.empty()}>
                    <PromptProjectAddButton controller={projectController} />
                  </Show>
                  <Show when={projectController.selected()}>
                    <div
                      class="flex min-h-7 min-w-0 items-center gap-0 text-v2-text-text-faint"
                      classList={{
                        "flex-col justify-center sm:flex-row": showWorkspaceBar(),
                        "justify-center": !showWorkspaceBar(),
                      }}
                    >
                      <PromptProjectSelector controller={projectController} placement="bottom" />
                      <Show when={showWorkspaceBar()}>
                        <PromptWorkspaceSelector
                          value={newSessionWorktree()}
                          projectRoot={projectRoot()}
                          workspaces={sync().project?.sandboxes ?? []}
                          branch={selectedBranch()}
                          onChange={(value) =>
                            setStore(
                              "worktree",
                              value === "main" && sync().project?.worktree !== sdk().directory
                                ? sync().project?.worktree
                                : value,
                            )
                          }
                          onDone={promptInputV2Controller.restoreFocus}
                        />
                      </Show>
                    </div>
                  </Show>
                  <ProviderTip
                    ready={() => serverSync().child(sdk().directory)[0].provider_ready}
                    connected={() => providers.paid().length > 0}
                    openProviders={openProviders}
                  />
                  <PromptInputV2Composer controller={promptInputV2Controller} />
                </div>
                {/*</Show>*/}
              </div>
            </NewSessionDesignView>
          </div>
        </div>
      </div>
    </div>
  )
}

function ProviderTip(props: { ready: () => boolean; connected: () => boolean; openProviders: () => void }) {
  const language = useLanguage()
  const [persistedState, setPersistedState, , persistedReady] = persisted(
    Persist.global("new-session.provider-tip"),
    createStore({ dismissedAt: 0 }),
  )
  const visible = createMemo(
    () =>
      props.ready() &&
      persistedReady() &&
      !props.connected() &&
      Date.now() - persistedState.dismissedAt >= providerTipDismissalDuration,
  )

  function dismiss() {
    setPersistedState("dismissedAt", Date.now())
  }

  const [ref, setRef] = createSignal<HTMLDivElement>()
  const presence = createPresence({
    show: () => visible(),
    element: () => ref() ?? null,
  })

  return (
    <Show when={presence.present()}>
      <div data-component="workbench-banner" class="flex justify-center">
        <div
          ref={setRef}
          data-component="provider-tip"
          data-visible={visible()}
          class="group/provider-tip relative flex min-h-8 w-full items-center justify-between gap-3 transition-[opacity,transform] duration-[180ms] ease-out motion-reduce:transition-none"
          classList={{
            "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true,
          }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={props.openProviders}
          >
            <span class="truncate">{language.t("home.providerTip")}</span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <IconV2 name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <TooltipV2
            class="flex h-8 w-8 shrink-0 items-center justify-center"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={dismiss}
            >
              <IconV2 name="xmark-small" />
            </button>
          </TooltipV2>
        </div>
      </div>
    </Show>
  )
}
