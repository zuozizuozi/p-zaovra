import { openFeedback } from "@/feedback"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@zaovra-ai/ui/icon"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettingsDialog } from "./settings-dialog"
import { BrandMark } from "./brand-mark"

export function DesktopRail() {
  const navigate = useNavigate()
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const openSettings = useSettingsDialog()
  const openUsage = useSettingsDialog("usage")
  const openAbout = useSettingsDialog("about")
  const closeSettings = () => window.dispatchEvent(new Event("zaovra:settings-close"))
  return (
    <nav data-component="desktop-rail" aria-label={language.t("home.title")}>
      <button
        title={language.t("home.title")}
        aria-label={language.t("home.title")}
        onClick={() => {
          closeSettings()
          navigate("/")
        }}
      >
        <Icon name="bubble-5" />
      </button>
      <button
        title={language.t("command.palette")}
        aria-label={language.t("command.palette")}
        onClick={() => {
          closeSettings()
          command.trigger("command.palette")
        }}
      >
        <Icon name="magnifying-glass" />
      </button>
      <button title={language.t("usage.title")} aria-label={language.t("usage.title")} onClick={openUsage}>
        <Icon name="bullet-list" />
      </button>
      <div class="flex-1" />
      <MenuV2>
        <MenuV2.Trigger aria-label={language.t("sidebar.settings")} title={language.t("sidebar.settings")}>
          <BrandMark class="size-7" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item onSelect={openSettings}>{language.t("sidebar.settings")}</MenuV2.Item>
            <MenuV2.Item data-feedback-entry="menu" onSelect={() => openFeedback()}>
              {language.t("sidebar.sendFeedback")}
            </MenuV2.Item>
            <MenuV2.Item onSelect={openAbout}>{language.t("settings.about.title")}</MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </nav>
  )
}
