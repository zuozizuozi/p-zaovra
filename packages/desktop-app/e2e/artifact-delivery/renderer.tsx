import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@zaovra-ai/app"
import type { ElectronAPI } from "../../src/preload/types"

// Actual App providers and product IPC; only the host's startup/server selection is fixed for this isolated run.
const api = (window as Window & { api: ElectronAPI }).api
const server: ServerConnection.Http = { type: "http", http: { url: "http://127.0.0.1:4563" } }
const platform: Platform = {
  platform: "desktop",
  os: "windows",
  channel: "dev",
  artifactPreview: api.artifactPreview,
  openDirectoryPickerDialog: (options) => api.openDirectoryPicker(options ?? {}),
  openLink: (url) => void api.openLink(url),
  back: () => history.back(),
  forward: () => history.forward(),
  restart: async () => location.reload(),
  notify: async () => {},
}
render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface
          defaultServer={ServerConnection.key(server)}
          canonicalLocalServer={ServerConnection.key(server)}
          servers={[server]}
          disableHealthCheck
        />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
