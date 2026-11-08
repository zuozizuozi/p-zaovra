import { useLanguage } from "@/context/language"
import { useHighlights } from "@/context/highlights"
import { Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { BrandMark } from "../brand-mark"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { showPackagedUpdater, updaterDetail, useUpdaterAction } from "../updater-action"

export function SettingsAbout() {
  const language = useLanguage()
  const platform = usePlatform()
  const updater = useUpdaterAction()
  const highlights = useHighlights()
  const update = () => platform.updater?.state()
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
      <a
        href="https://zaovra.com"
        data-action="open-website"
        class="self-start text-14-regular text-text-interactive-base hover:underline"
        onClick={(event) => {
          event.preventDefault()
          platform.openLink("https://zaovra.com")
        }}
      >
        {language.t("settings.about.website")}
      </a>
    </div>
  )
}
