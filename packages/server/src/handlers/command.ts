import { CommandSources } from "@zaovra-ai/core/command-sources"
import { InvalidRequestError } from "@zaovra-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  handlers
    .handle("command.list", () => response(CommandSources.list(), "catalog"))
    .handle("command.render", (ctx) =>
      response(
        CommandSources.render(ctx.payload.name, ctx.payload.arguments, ctx.payload.agent).pipe(
          Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: "command_source" })),
        ),
        "catalog",
      ),
    ),
)
