import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "../../src/app"
import { PlatformProvider, type Platform } from "../../src/context/platform"
import { ServerConnection } from "../../src/context/server"
import { SettingsProvider } from "../../src/context/settings"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { DialogReleaseNotes } from "../../src/components/dialog-release-notes"
import "../../src/index.css"

const platform: Platform = {
  platform: "desktop",
  os: "windows",
  version: "inline-home-fixture",
  windowID: "inline-home",
  openLink() {},
  restart: async () => {},
  back: () => history.back(),
  forward: () => history.forward(),
  notify: async () => {},
  openDirectoryPickerDialog: async () => null,
}

function ReleaseProbe() {
  const dialog = useDialog()
  const open = () =>
    dialog.show(() => (
      <DialogReleaseNotes
        version="0.1.1-beta.20"
        highlights={[
          { title: "界面细节 / Interface", description: "原位改名与首页清理 / Inline rename and a clean start." },
        ]}
      />
    ))
  return (
    <button
      data-inline-release
      style={{ position: "fixed", bottom: "5px", right: "5px", "z-index": 10 }}
      onClick={open}
    >
      Release test
    </button>
  )
}

render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={new URLSearchParams(location.search).get("locale") === "en" ? "en" : "zh"}>
        <SettingsProvider>
          <ReleaseProbe />
        </SettingsProvider>
        <AppInterface
          disableHealthCheck
          defaultServer={ServerConnection.Key.make(location.origin)}
          canonicalLocalServer={ServerConnection.Key.make(location.origin)}
          servers={[{ type: "http", http: { url: location.origin } }]}
        />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
