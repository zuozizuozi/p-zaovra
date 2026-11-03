import { app } from "electron"
import { DEEP_LINK_PROTOCOLS } from "@zaovra-ai/app/deep-link-protocol"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.ZAOVRA_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
export const DEEP_LINK_PROTOCOL = DEEP_LINK_PROTOCOLS[CHANNEL]

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
