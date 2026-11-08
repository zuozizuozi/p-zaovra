import { useLanguage } from "@/context/language"
import { useHighlights } from "@/context/highlights"
import { Show, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { BrandMark } from "../brand-mark"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { showPackagedUpdater, updaterDetail, useUpdaterAction } from "../updater-action"

export function SettingsAbout() {
  const language = useLanguage()
  const platform = usePlatform()
  const updater = useUpdaterAction()
  const highlights = useHighlights()
  const [state, setState] = createStore<{ document?: "notices" }>({})
  const update = () => platform.updater?.state()
  const [text] = createResource(
    () => state.document,
    (document) => platform.legalDocument?.(document),
  )
  return (
    <div class="settings-v2-tab-body">
      <BrandMark class="size-16" />
      <h2 class="text-24-semibold">Zaovra</h2>
      <p>
        {language.t("settings.about.version")} {platform.version ?? language.t("settings.about.dev")}
      </p>
      <Show when={platform.channel}>
        <p>
          {language.t("settings.about.channel")}: {platform.channel}
        </p>
      </Show>
      <Show when={showPackagedUpdater(platform)}>
        <div class="flex flex-wrap items-center gap-3" data-component="about-updater">
          <div role="status" aria-live="polite">
            <p>{language.t(`settings.about.updater.${platform.updater!.state().status}`)}</p>
            <Show when={updaterDetail(update())}>{(detail) => <p>{detail()}</p>}</Show>
          </div>
          <ButtonV2 variant="neutral" disabled={!updater.action().run} onClick={updater.run}>
            {language.t(updater.action().label)}
          </ButtonV2>
        </div>
      </Show>
      <Show when={highlights.available()}>
        <ButtonV2 variant="neutral" onClick={highlights.show}>
          {language.t("settings.general.row.releaseNotes.view")}
        </ButtonV2>
      </Show>
      <p>© 2026 Zaovra</p>
      <Show when={platform.legalDocument}>
        <div class="flex gap-3">
          <ButtonV2 variant="neutral" onClick={() => setState("document", "notices")}>
            {language.t("settings.about.notices")}
          </ButtonV2>
        </div>
        <Show when={text.loading}>
          <p>{language.t("settings.about.loading")}</p>
        </Show>
        <Show when={text.error}>
          <p>{language.t("settings.about.error")}</p>
        </Show>
        <Show when={text()}>
          <pre class="whitespace-pre-wrap break-words text-12-regular">{text()}</pre>
        </Show>
      </Show>
    </div>
  )
}
