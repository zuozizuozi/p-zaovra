export * as ApplicationTools from "./application-tools"

import { Context, Effect, Layer, Scope } from "effect"
import { State } from "../state"
import { Tool } from "./tool"
import { makeGlobalNode } from "../effect/app-node"

type Data = {
  readonly entries: Map<string, Entry>
}

type Draft = {
  readonly set: (name: string, entry: Entry) => void
}

export interface Entry {
  readonly identity: object
  readonly tool: Tool.AnyTool
  /** Set only by trusted shipped registration code, never returned tool annotations. */
  readonly origin?: "shipped"
}

export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
    origin?: "shipped",
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
  readonly entries: () => ReadonlyMap<string, Entry>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/ApplicationTools") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ entries: new Map() }),
      draft: (draft) => ({
        set: (name, tool) => {
          draft.entries.set(name, tool)
        },
      }),
    })

    return Service.of({
      register: Effect.fn("ApplicationTools.register")(function* (tools, origin) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => Tool.validateName(name), { discard: true })
        const registrations = entries.map(([name, tool]) => [name, { identity: {}, tool, origin }] as const)
        yield* state.transform((draft) => {
          for (const [name, entry] of registrations) draft.set(name, entry)
        })
      }),
      entries: () => state.get().entries,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
