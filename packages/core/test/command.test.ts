import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { CommandV2 } from "@zaovra-ai/core/command"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(CommandV2.node))

describe("CommandV2", () => {
  it.effect("784 command draft can edit hints while the public contract preserves the wire", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* command.transform((editor) => {
        editor.update("plan", (entry) => {
          entry.template = "Plan $ARGUMENTS"
          entry.hints = ["<topic>"]
        })
        editor.get("plan")?.hints?.push("[scope]")
        editor.list()[0]?.hints?.push("[format]")
      })
      const entry = yield* command.get("plan")
      expect(entry?.hints).toEqual(["<topic>", "[scope]", "[format]"])
      expect(Schema.encodeSync(CommandV2.Info)(entry!)).toEqual({
        name: "plan",
        template: "Plan $ARGUMENTS",
        hints: ["<topic>", "[scope]", "[format]"],
      })
      expect(Schema.encodeSync(CommandV2.Info)({ name: "plain", template: "text" })).not.toHaveProperty("hints")
    }),
  )

  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        CommandV2.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        CommandV2.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      ])
    }),
  )
})
