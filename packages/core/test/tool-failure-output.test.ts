import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Global } from "@zaovra-ai/core/global"
import { Evidence } from "@zaovra-ai/core/evidence"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Tool } from "@zaovra-ai/core/tool/tool"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { settleTool, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_failure_bounds")
const call = {
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "failure", name: "failed", input: {} },
}

for (const sample of [
  { name: "bytes", message: "HEAD" + "x".repeat(60_000) + "TAIL" },
  { name: "lines", message: "line\n".repeat(2_100) },
  { name: "unicode", message: "🙂中文".repeat(10_000) },
  { name: "input rejection", message: "Invalid input: " + "x".repeat(60_000), phase: "input" },
  { name: "short", message: "Permission denied" },
]) {
  test(`ToolFailure ${sample.name} stays an error with lossless evidence and no rerun`, async () => {
    await using root = await tmpdir()
    const executions: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const evidence = yield* Evidence.Service
        yield* registry.register({
          failed: Tool.make({
            description: "Fail with diagnostic text",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () =>
              Effect.sync(() => executions.push("called")).pipe(
                Effect.flatMap(() =>
                  Effect.fail(new Tool.Failure({ message: sample.message, metadata: { phase: sample.phase } })),
                ),
              ),
          }),
        })
        const result = yield* settleTool(registry, call)
        expect(result.result.type).toBe("error")
        expect(result.inputRejected).toBe(sample.phase === "input")
        expect(result.output).toBeUndefined()
        if (result.result.type !== "error") throw new Error("expected error")
        const preview = result.result.value
        expect(preview.isWellFormed()).toBe(true)
        expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
        expect(preview.split("\n").length).toBeLessThanOrEqual(ToolOutputStore.MAX_LINES)
        if (sample.name === "short") {
          expect(preview).toBe(sample.message)
          expect(result.outputPaths).toBeUndefined()
        } else {
          expect(result.outputPaths).toHaveLength(1)
          const file = result.outputPaths![0]
          const id = Evidence.reference(sessionID, file)
          expect(preview).toContain(id)
          expect(preview).not.toContain(file)
          expect(preview).toContain("truncated")
          const pages: string[] = []
          let offset = 0
          for (;;) {
            const page = yield* evidence.read(sessionID, id, offset, 32768)
            pages.push(page.text)
            if (page.nextOffset === undefined) break
            expect(page.nextOffset).toBeGreaterThan(offset)
            offset = page.nextOffset
          }
          expect(pages.join("")).toBe(sample.message)
        }
        expect(executions).toEqual(["called"])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, Evidence.node]), [
            [Global.node, Global.layerWith({ data: root.path })],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ]),
        ),
      ),
    )
  })
}

test("failed error retention propagates StorageError instead of pretending the error was retained", async () => {
  await using root = await tmpdir()
  await fs.writeFile(path.join(root.path, "tool-output"), "blocks managed directory")
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        failed: Tool.make({
          description: "Failure",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.fail(new Tool.Failure({ message: "x".repeat(60_000) })),
        }),
      })
      const exit = yield* settleTool(registry, call).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        expect(error).toBeInstanceOf(ToolOutputStore.StorageError)
        expect(error?.message).toContain("Failed to write tool output")
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, Evidence.node]), [
          [Global.node, Global.layerWith({ data: root.path })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ]),
      ),
    ),
  )
})

test("tool interruption stays interruption and produces no error evidence", async () => {
  await using root = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        failed: Tool.make({
          description: "Interrupted",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.interrupt,
        }),
      })
      const exit = yield* settleTool(registry, call).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, Evidence.node]), [
          [Global.node, Global.layerWith({ data: root.path })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ]),
      ),
    ),
  )
  expect(await fs.readdir(root.path)).toEqual([])
})

test("failed command keeps both captured log and full error available", async () => {
  await using root = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const evidence = yield* Evidence.Service
      yield* registry.register({
        failed: Tool.make({
          description: "Captured failure",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.gen(function* () {
              const capture = Option.getOrThrow(yield* Effect.serviceOption(ToolOutputStore.Capture))
              yield* capture.append(new TextEncoder().encode("command ran once")).pipe(Effect.orDie)
              return yield* Effect.fail(new Tool.Failure({ message: "x".repeat(60_000) }))
            }),
        }),
      })
      const result = yield* settleTool(registry, call)
      expect(result.result.type).toBe("error")
      expect(result.outputPaths).toHaveLength(2)
      if (result.result.type !== "error") throw new Error("expected error")
      expect(Buffer.byteLength(result.result.value)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      for (const file of result.outputPaths!) {
        expect(result.result.value).toContain(Evidence.reference(sessionID, file))
        expect(result.result.value).not.toContain(file)
      }
      const log = yield* evidence.read(sessionID, Evidence.reference(sessionID, result.outputPaths![0]), 0, 1024)
      expect(log.text).toBe("command ran once")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, Evidence.node]), [
          [Global.node, Global.layerWith({ data: root.path })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ]),
      ),
    ),
  )
})
