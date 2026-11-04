import { join } from "node:path"

export function sidecarDirectory(userDataPath: string) {
  return join(userDataPath, "config", "zaovra")
}

export function createSidecarEnv(input: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  packaged: boolean
  channel: string
  userDataPath: string
  resourcesPath?: string
}): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(input.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  )
  delete env.DEBUG
  if (input.platform === "linux") delete env.LD_PRELOAD
  env.ZAOVRA_DISABLE_CHANNEL_DB = "1"
  if (input.packaged && input.platform === "win32" && input.resourcesPath)
    env.ZAOVRA_RG_PATH = join(input.resourcesPath, "bin", "rg.exe")
  // Electron's channel/profile boundary must also cover the backend's database,
  // credentials, provider configuration, cache and locks, including dev builds.
  for (const [key, directory] of [
    ["XDG_DATA_HOME", "data"],
    ["XDG_CONFIG_HOME", "config"],
    ["XDG_CACHE_HOME", "cache"],
    ["XDG_STATE_HOME", "state"],
  ])
    env[key] = join(input.userDataPath, directory)
  for (const key of ["ZAOVRA_DB", "ZAOVRA_CONFIG", "ZAOVRA_CONFIG_DIR", "ZAOVRA_CONFIG_CONTENT"]) delete env[key]
  for (const key of ["TMP", "TEMP", "TMPDIR"]) env[key] = join(input.userDataPath, "temp")
  return env
}
