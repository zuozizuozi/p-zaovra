import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "../../src/app"
import { PlatformProvider, type Platform } from "../../src/context/platform"
import { ServerConnection } from "../../src/context/server"
import "../../src/index.css"

// Real desktop layout in a browser host; native file actions are intentionally absent.
// This local test entry is excluded from the ordinary application build.
const platform: Platform = {
  platform: "desktop",
  os: "windows",
  version: "1.18.3",
  windowID: "qa550",
  openLink: () => {},
  restart: async () => {},
  back: () => history.back(),
  forward: () => history.forward(),
  notify: async () => {},
  openDirectoryPickerDialog: async () => null,
}
render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale="zh">
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
