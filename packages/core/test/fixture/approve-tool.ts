import { Effect, Fiber } from "effect"
import { PermissionV2 } from "../../src/permission"
import { LocationServiceMap } from "../../src/location-service-map"
import { Location } from "../../src/location"
import { PluginV2 } from "../../src/plugin"
import { PluginInternal } from "../../src/plugin/internal"
import type { AbsolutePath } from "../../src/schema"
import type { SessionV2 } from "../../src/session"
import type { ToolRegistry } from "../../src/tool/registry"
import { settleTool } from "../lib/tool"

/** Explicit one-call fixture actor, not a production default-allow bypass. */
export const settleToolApproved = Effect.fn("fixture.settleToolApproved")(function* (
  registry: ToolRegistry.Interface,
  input: ToolRegistry.ExecuteInput,
  observed?: PermissionV2.Request[],
) {
  if (input.call.name !== "bash") return yield* settleTool(registry, input)
  const permissions = yield* PermissionV2.Service
  const command = input.call.input
  if (typeof command !== "object" || !command || !("command" in command) || typeof command.command !== "string")
    return yield* Effect.die("Fixture approval requires the declared exact command")
  return yield* Effect.acquireUseRelease(
    Effect.forkChild(settleTool(registry, input)),
    (fiber) =>
      Effect.gen(function* () {
        while (fiber.pollUnsafe() === undefined) {
          for (const request of yield* permissions.forSession(input.sessionID)) {
            if (
              request.source?.type !== "tool" ||
              request.source.messageID !== input.assistantMessageID ||
              request.source.callID !== input.call.id
            )
              continue
            if (!["bash", "external_directory"].includes(request.action))
              return yield* Effect.die(`Unexpected fixture permission action: ${request.action}`)
            if (
              request.action === "bash" &&
              (request.resources.length !== 1 || request.resources[0] !== command.command)
            )
              return yield* Effect.die("Fixture approval cannot authorize another command")
            // Reply only to the actual current pending request. Explicit deny has
            // no pending request and cannot be converted into allow by this actor.
            observed?.push(request)
            yield* permissions.reply({ requestID: request.id, reply: "once" })
          }
          // This fixture actor represents an independent user, even when the
          // command's own wait is driven by TestClock.
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))
        }
        return yield* Fiber.join(fiber)
      }),
    (fiber) => Fiber.interrupt(fiber),
  )
})

/** Explicit fixture-user consent to one fixed literal, before crash/replay phases. */
export const grantFixtureCommand = Effect.fn("fixture.grantFixtureCommand")(function* (
  sessionID: SessionV2.ID,
  directory: AbsolutePath,
  command: string,
) {
  const locations = yield* LocationServiceMap.Service
  return yield* Effect.gen(function* () {
    // The real Location installs built-in/configured agent permissions
    // asynchronously. Ask after that same readiness boundary as the runner.
    const plugins = yield* PluginV2.Service
    yield* plugins.wait(PluginInternal.agentReadyID)
    const permissions = yield* PermissionV2.Service
    const request = yield* permissions.ask({
      sessionID,
      action: "bash",
      resources: [command],
      save: [command],
      saveMode: "literal",
      origin: "api",
      requireConfirmation: true,
    })
    if (request.effect === "deny") return yield* Effect.die("Fixture consent cannot override deny")
    if (request.effect === "ask") yield* permissions.reply({ requestID: request.id, reply: "always" })
    console.error("FIXTURE_EXACT_APPROVAL", JSON.stringify({ sessionID, command, effect: request.effect }))
  }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory }))))
})
