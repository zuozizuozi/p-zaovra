import { useLayout, useServer, useSettings, useTabs } from "@zaovra-ai/app"
import { onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { t } from "./i18n"

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string; onLoaded: () => void }) {
  const server = useServer()
  const layout = useLayout()
  const settings = useSettings()
  const tabs = useTabs()
  const [state, setState] = createStore({ needsDirectory: false, busy: false })

  async function open(directory: string) {
    server.projects.open(directory)
    server.projects.touch(directory)
    const tab = await tabs.newDraft({ server: server.key, directory })
    if (!tab) throw new Error("Onboarding directory did not resolve to a draft")
    tabs.select(tab)
    layout.sidebar.open()
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

  onMount(() => {
    void runFirstLaunchOnboarding().finally(props.onLoaded)
  })

  async function runFirstLaunchOnboarding() {
    try {
      await Promise.all(
        [server.ready.promise, layout.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map(
          (p) => p ?? Promise.resolve(),
        ),
      )
      const existingInstall = await window.api.isOldLayoutEligible()
      settings.general.setOldLayoutEligible(existingInstall)
      if (!server.isLocal()) return

      if (tabs.store.length > 0) {
        if (props.initialUrl === "/") tabs.toggleHome({ home: true })
        return
      }
      const pending = await window.api.isFirstLaunchOnboardingPending()

      const shouldTrigger = tabs.store.length === 0 && server.projects.list().length === 0

      console.info("[desktop-onboarding] first launch onboarding evaluated", {
        pending,
        shouldTrigger,
        existingInstall,
        initialUrl: props.initialUrl,
        tabs: tabs.store.length,
        projects: server.projects.list().length,
      })

      const result = await window.api.finishFirstLaunchOnboarding(shouldTrigger)
      if (!shouldTrigger || !result) return
      if ("needsDirectory" in result) {
        setState("needsDirectory", true)
        return
      }
      await open(result.directory)
    } catch (error) {
      console.error("[desktop-onboarding] first launch onboarding failed", error)
      setState("needsDirectory", true)
    }
  }

  return (
    <Show when={state.needsDirectory}>
      <section
        role="status"
        class="fixed bottom-4 right-4 z-40 flex max-w-sm items-center gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base p-3 text-v2-text-text-base shadow-lg"
      >
        <p>{t("desktop.onboarding.choose")}</p>
        <ButtonV2 variant="neutral" disabled={state.busy} onClick={() => void choose()}>
          {t("desktop.dialog.chooseFolder")}
        </ButtonV2>
      </section>
    </Show>
  )
}
