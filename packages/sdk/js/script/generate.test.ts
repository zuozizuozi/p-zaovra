import { expect, test } from "bun:test"
import { memoryParameters } from "./generate"

const source = `export class Memory {
  create(parameters?: { body_text?: string; text?: string; layer?: string }) {}
}
export class Session { prompt(parameters?: { prompt?: string }) {} }`
const document = (required: boolean) => ({
  paths: {
    "/api/memory": {
      post: {
        operationId: "v2.memory.create",
        parameters: [{ name: "text" }],
        requestBody: {
          required,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { text: { type: "string" }, layer: { type: "string" } },
                required: ["text"],
              },
            },
          },
        },
      },
    },
  },
})

test("memory flat correction preserves query collisions, optional fields and other classes", () => {
  expect(memoryParameters(source, document(true))).toBe(
    source.replace("parameters?:", "parameters:").replace("body_text?:", "body_text:"),
  )
})
test("optional request bodies retain the legacy optional signature", () => {
  expect(memoryParameters(source, document(false))).toBe(source)
})
test("changed generator shapes fail instead of silently leaving a required field optional", () => {
  expect(() => memoryParameters(source.replace("body_text", "unexpected"), document(true))).toThrow("field is missing")
})
