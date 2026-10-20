import { ServerConnection, useServer, useSettings, useTabs } from "@zaovra-ai/app"
import { onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { t } from "./i18n"

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string; onLoaded: () => void }) {
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()
  const [state, setState] = createStore({ needsDirectory: false, fallback: "", busy: false })

  async function open(directory: string) {
    server.projects.open(directory)
    server.projects.touch(directory)
    const tab = await tabs.newDraft({ server: server.key, directory })
    if (!tab) throw new Error("Onboarding directory did not resolve to a draft")
    tabs.select(tab)
  }

  async function choose() {
    setState("busy", true)
    try {
      const selected = await window.api.openDirectoryPicker({ multiple: false })
      const directory = Array.isArray(selected) ? selected[0] : selected
      if (!directory) return
      await open(directory)
      await window.api.finishFirstLaunchOnboarding(false)
      setState("needsDirectory", false)
    } catch {
      setState("needsDirectory", true)
    } finally {
      setState("busy", false)
    }
  }

  async function skip() {
    setState("busy", true)
    try {
      await window.api.finishFirstLaunchOnboarding(false)
      setState("needsDirectory", false)
    } catch {
      setState("needsDirectory", true)
    } finally {
      setState("busy", false)
    }
  }

  onMount(() => {
    void runFirstLaunchOnboarding().finally(props.onLoaded)
  })

  async function runFirstLaunchOnboarding() {
    try {
      await Promise.all(
        [server.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map((p) => p ?? Promise.resolve()),
      )
      const existingInstall = await window.api.isOldLayoutEligible()
      settings.general.setOldLayoutEligible(existingInstall)
      if (!server.isLocal()) return

      const pending = await window.api.isFirstLaunchOnboardingPending()
      if (!pending) return

      const shouldTrigger =
        !existingInstall &&
        props.initialUrl === "/" &&
        tabs.store.length === 0 &&
        server.list.every(ServerConnection.builtin)

      console.info("[desktop-onboarding] first launch onboarding evaluated", {
        pending,
        shouldTrigger,
        existingInstall,
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        servers: server.list.map(ServerConnection.key),
      })

      const result = await window.api.finishFirstLaunchOnboarding(shouldTrigger)
      if (!shouldTrigger || !result) return
      if ("needsDirectory" in result) {
        setState("needsDirectory", true)
        return
      }
      if (result.fallback) setState("fallback", result.directory)
      await open(result.directory)
    } catch (error) {
      console.error("[desktop-onboarding] first launch onboarding failed", error)
      setState("needsDirectory", true)
    }
  }

  return (
    <Show when={state.needsDirectory || state.fallback}>
      <section
        role="status"
        class="fixed bottom-4 left-16 right-4 z-50 flex flex-wrap items-center gap-3 bg-v2-background-bg-base p-4 text-v2-text-text-base"
      >
        <p class="min-w-0 flex-1 break-words">
          {state.needsDirectory
            ? t("desktop.onboarding.choose")
            : t("desktop.onboarding.fallback", { path: state.fallback })}
        </p>
        <Show
          when={state.needsDirectory}
          fallback={
            <ButtonV2 variant="ghost-muted" onClick={() => setState("fallback", "")}>
              {t("desktop.onboarding.dismiss")}
            </ButtonV2>
          }
        >
          <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void choose()}>
            {t("desktop.dialog.chooseFolder")}
          </ButtonV2>
          <ButtonV2 variant="ghost-muted" disabled={state.busy} onClick={() => void skip()}>
            {t("desktop.onboarding.later")}
          </ButtonV2>
        </Show>
      </section>
    </Show>
  )
}
