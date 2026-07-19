declare global {
  const ZAOVRA_VERSION: string
  const ZAOVRA_CHANNEL: string
}

export const InstallationVersion = typeof ZAOVRA_VERSION === "string" ? ZAOVRA_VERSION : "local"
export const InstallationChannel = typeof ZAOVRA_CHANNEL === "string" ? ZAOVRA_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
