import { join } from "node:path"

export function createSidecarEnv(input: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  packaged: boolean
  channel: string
  userDataPath: string
}): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(input.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  )
  delete env.DEBUG
  if (input.platform === "linux") delete env.LD_PRELOAD
  if (!input.packaged) env.ZAOVRA_DISABLE_CHANNEL_DB = "1"
  if (input.packaged && input.channel === "prod") {
    // A shared XDG root must not let a newer dev database migrate the installed app's history.
    env.XDG_DATA_HOME = join(input.userDataPath, "data")
  }
  return env
}
