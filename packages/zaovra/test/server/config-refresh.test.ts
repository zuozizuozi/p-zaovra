import { expect } from "bun:test"
import { Context, Effect, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@zaovra-ai/core/cross-spawn-spawner"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Location } from "@zaovra-ai/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@zaovra-ai/core/location-services"
import { QuestionV2 } from "@zaovra-ai/core/question"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { ConfigRefresh } from "../../src/server/shared/config-refresh"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.merge(buildLocationServiceMap(), LayerNode.compile(CrossSpawnSpawner.node)))

it.live("refreshes future consumers while an active question can still be answered", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const locations = yield* LocationServiceMap.Service
    const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    const original = yield* locations.contextEffect(ref)
    const alternate = Location.Ref.make({
      directory: AbsolutePath.make(directory.replaceAll("\\", "/") + "/"),
    })
    expect(Context.get(yield* locations.contextEffect(alternate), QuestionV2.Service)).toBe(
      Context.get(original, QuestionV2.Service),
    )
    expect(yield* QuestionV2.Service.pipe(Effect.provide(locations.get(alternate)))).toBe(
      Context.get(original, QuestionV2.Service),
    )
    const other = Location.Ref.make({ directory: AbsolutePath.make(yield* tmpdirScoped({ git: true })) })
    const untouched = yield* locations.contextEffect(other)
    const questions = Context.get(original, QuestionV2.Service)
    const pending = yield* questions
      .ask({
        sessionID: SessionV2.ID.make("ses_config_refresh"),
        questions: [
          {
            header: "Continue",
            question: "Continue after saving settings?",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      })
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const request = yield* pollWithTimeout(
      questions.list().pipe(Effect.map((items) => items[0])),
      "question was not admitted",
    )
    yield* ConfigRefresh.refresh(directory)
    const refreshed = yield* locations.contextEffect(alternate)
    expect(Context.get(yield* locations.contextEffect(other), QuestionV2.Service)).toBe(
      Context.get(untouched, QuestionV2.Service),
    )
    const replies = Context.get(refreshed, QuestionV2.Service)
    expect(replies).not.toBe(questions)
    expect(yield* replies.list()).toEqual([request])
    yield* replies.reply({ requestID: request.id, answers: [["Yes"]] })
    expect(yield* Fiber.join(pending)).toEqual([["Yes"]])
    expect(yield* questions.list()).toEqual([])
    yield* locations.invalidate(alternate)
    expect(Context.get(yield* locations.contextEffect(ref), QuestionV2.Service)).not.toBe(replies)
    yield* ConfigRefresh.refresh()
    expect(Context.get(yield* locations.contextEffect(other), QuestionV2.Service)).not.toBe(
      Context.get(untouched, QuestionV2.Service),
    )
  }),
)
