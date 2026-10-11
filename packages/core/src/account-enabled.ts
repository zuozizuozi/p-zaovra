declare const ZAOVRA_ACCOUNT_ENABLED: boolean

// Account access is a build capability, not an environment override in installed apps.
export const accountEnabled = typeof ZAOVRA_ACCOUNT_ENABLED === "boolean" && ZAOVRA_ACCOUNT_ENABLED
