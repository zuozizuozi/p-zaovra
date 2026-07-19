import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["ZAOVRA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["ZAOVRA_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("ZAOVRA_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  ZAOVRA_AUTO_HEAP_SNAPSHOT: truthy("ZAOVRA_AUTO_HEAP_SNAPSHOT"),
  ZAOVRA_GIT_BASH_PATH: process.env["ZAOVRA_GIT_BASH_PATH"],
  ZAOVRA_CONFIG: process.env["ZAOVRA_CONFIG"],
  ZAOVRA_CONFIG_CONTENT: process.env["ZAOVRA_CONFIG_CONTENT"],
  ZAOVRA_DISABLE_AUTOUPDATE: truthy("ZAOVRA_DISABLE_AUTOUPDATE"),
  ZAOVRA_ALWAYS_NOTIFY_UPDATE: truthy("ZAOVRA_ALWAYS_NOTIFY_UPDATE"),
  ZAOVRA_DISABLE_PRUNE: truthy("ZAOVRA_DISABLE_PRUNE"),
  ZAOVRA_DISABLE_TERMINAL_TITLE: truthy("ZAOVRA_DISABLE_TERMINAL_TITLE"),
  ZAOVRA_SHOW_TTFD: truthy("ZAOVRA_SHOW_TTFD"),
  ZAOVRA_DISABLE_AUTOCOMPACT: truthy("ZAOVRA_DISABLE_AUTOCOMPACT"),
  ZAOVRA_DISABLE_MODELS_FETCH: truthy("ZAOVRA_DISABLE_MODELS_FETCH"),
  ZAOVRA_DISABLE_MOUSE: truthy("ZAOVRA_DISABLE_MOUSE"),
  ZAOVRA_FAKE_VCS: process.env["ZAOVRA_FAKE_VCS"],
  ZAOVRA_SERVER_PASSWORD: process.env["ZAOVRA_SERVER_PASSWORD"],
  ZAOVRA_SERVER_USERNAME: process.env["ZAOVRA_SERVER_USERNAME"],
  ZAOVRA_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("ZAOVRA_DISABLE_FFF"),

  // Experimental
  ZAOVRA_EXPERIMENTAL_FILEWATCHER: Config.boolean("ZAOVRA_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ZAOVRA_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("ZAOVRA_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  ZAOVRA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("ZAOVRA_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  ZAOVRA_MODELS_URL: process.env["ZAOVRA_MODELS_URL"],
  ZAOVRA_MODELS_PATH: process.env["ZAOVRA_MODELS_PATH"],
  ZAOVRA_DB: process.env["ZAOVRA_DB"],

  ZAOVRA_WORKSPACE_ID: process.env["ZAOVRA_WORKSPACE_ID"],
  ZAOVRA_EXPERIMENTAL_WORKSPACES: enabledByExperimental("ZAOVRA_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get ZAOVRA_DISABLE_PROJECT_CONFIG() {
    return truthy("ZAOVRA_DISABLE_PROJECT_CONFIG")
  },
  get ZAOVRA_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("ZAOVRA_EXPERIMENTAL_REFERENCES")
  },
  get ZAOVRA_TUI_CONFIG() {
    return process.env["ZAOVRA_TUI_CONFIG"]
  },
  get ZAOVRA_CONFIG_DIR() {
    return process.env["ZAOVRA_CONFIG_DIR"]
  },
  get ZAOVRA_PURE() {
    return truthy("ZAOVRA_PURE")
  },
  get ZAOVRA_PERMISSION() {
    return process.env["ZAOVRA_PERMISSION"]
  },
  get ZAOVRA_PLUGIN_META_FILE() {
    return process.env["ZAOVRA_PLUGIN_META_FILE"]
  },
  get ZAOVRA_CLIENT() {
    return process.env["ZAOVRA_CLIENT"] ?? "cli"
  },
}
