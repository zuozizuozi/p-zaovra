import { createHash } from "node:crypto"

export function wslBackendEnvironment(channel: "dev" | "beta" | "prod", userDataPath: string) {
  const profile = createHash("sha256").update(userDataPath).digest("hex").slice(0, 16)
  const root = `$HOME/.local/share/zaovra-desktop/${channel}/${profile}`
  return [
    `export XDG_DATA_HOME="${root}/data"`,
    `export XDG_CONFIG_HOME="${root}/config"`,
    `export XDG_CACHE_HOME="${root}/cache"`,
    `export XDG_STATE_HOME="${root}/state"`,
    'export TMPDIR="$XDG_CACHE_HOME/temp"',
    'mkdir -p "$TMPDIR"',
    'mkdir -p "$XDG_CONFIG_HOME/zaovra"',
    'cd "$XDG_CONFIG_HOME/zaovra"',
    "unset ZAOVRA_DB ZAOVRA_CONFIG ZAOVRA_CONFIG_DIR ZAOVRA_CONFIG_CONTENT",
    "export ZAOVRA_DISABLE_CHANNEL_DB=1",
  ]
}
