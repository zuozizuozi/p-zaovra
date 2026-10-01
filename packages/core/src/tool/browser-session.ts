export * as BrowserSession from "./browser-session"

import { Context, Effect } from "effect"
import type { SessionSchema } from "../session/schema"

// Session interruption needs the resource handle without importing tool registration.
export class Service extends Context.Service<Service, { close: (id: SessionSchema.ID) => Effect.Effect<void> }>()(
  "@zaovra/BrowserTool",
) {}
