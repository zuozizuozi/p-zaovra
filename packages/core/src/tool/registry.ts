export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@zaovra-ai/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { Evidence } from "../evidence"
import { PermissionV2 } from "../permission"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = Omit<Tool.Context, "toolCallID"> & {
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly inputRejected?: boolean
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    const evidence = yield* Evidence.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const capture = resources.capture()
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        ...(input.inputModalities === undefined ? {} : { inputModalities: input.inputModalities }),
      }).pipe(
        Effect.provideService(ToolOutputStore.Capture, capture),
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({
            result: { type: "error" as const, value: failure.message },
            inputRejected: failure.metadata?.phase === "input",
          }),
        ),
      )
      if ("result" in pending) {
        const bounded = yield* resources.bound({
          sessionID: input.sessionID,
          toolCallID: input.call.id,
          reference: (file) => `${Evidence.reference(input.sessionID, file)} (evidence_read / evidence_search)`,
          capturedPaths: capture.paths(),
          output: {
            structured: null,
            content: [
              {
                type: "text",
                text:
                  pending.result.value +
                  (capture.paths().length === 0 ? "" : `\nCommand log: ${capture.paths().join(", ")}`),
              },
            ],
          },
        })
        const outputPaths = [...capture.paths(), ...bounded.outputPaths]
        const ids = yield* evidence
          .retain(input.sessionID, input.call.id, outputPaths)
          .pipe(Effect.mapError((cause) => new ToolOutputStore.StorageError({ operation: "write", cause })))
        return ids.length === 0
          ? pending
          : {
              ...pending,
              result: {
                ...pending.result,
                value: bounded.output.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join(""),
              },
              outputPaths,
            }
      }
      const output =
        capture.paths().length === 0
          ? pending.output
          : {
              ...pending.output,
              content: [
                ...pending.output.content,
                { type: "text" as const, text: `\nCommand log: ${capture.paths().join(", ")}` },
              ],
            }
      const bounded = yield* resources.bound({
        sessionID: input.sessionID,
        toolCallID: input.call.id,
        output,
        reference: (file) => `${Evidence.reference(input.sessionID, file)} (evidence_read / evidence_search)`,
        capturedPaths: capture.paths(),
      })
      const outputPaths = [...capture.paths(), ...bounded.outputPaths]
      yield* evidence
        .retain(
          input.sessionID,
          input.call.id,
          outputPaths,
          pending.output.structured !== null &&
            typeof pending.output.structured === "object" &&
            "job_id" in pending.output.structured &&
            typeof pending.output.structured.job_id === "string"
            ? pending.output.structured.job_id
            : undefined,
        )
        .pipe(Effect.mapError((cause) => new ToolOutputStore.StorageError({ operation: "write", cause })))
      const retained = bounded.output
      const result = ToolOutput.toResultValue(retained)
      if (result.type === "error") return outputPaths.length > 0 ? { result, outputPaths } : { result }
      return outputPaths.length > 0 ? { result, output: retained, outputPaths } : { result, output: retained }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map(applications.entries())
        const disabled = new Set<string>()
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) {
            disabled.add(name)
            registrations.delete(name)
          }
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)).sort(
            (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
          ),
          settle: (input) => {
            if (disabled.has(input.call.name))
              return Effect.succeed({
                result: {
                  type: "error",
                  value: `Tool ${input.call.name} is disabled by the selected agent's permissions. Nothing was executed. Continue with the available tools; an execution-enabled mode requires user authorization.`,
                },
              })
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, Evidence.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node, Evidence.node],
})
