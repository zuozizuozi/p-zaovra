import { Slug } from "@zaovra-ai/core/util/slug"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.succeed(
    handlers.handle("generateName", (ctx) =>
      Effect.succeed({
        name: slugify(ctx.payload.context ?? "") || Slug.create(),
      }),
    ),
  ),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 3)
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
