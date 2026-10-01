import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Effect, Exit } from "effect"
import { ProviderShared } from "../src/protocols/shared"

const supported = new Set(["image/png"])
const validate = (data: string | Uint8Array) =>
  Effect.runPromise(
    Effect.exit(ProviderShared.validateMedia("test", { type: "media", mediaType: "image/png", data }, supported)),
  )

for (const size of [6 * 1024 * 1024, 20 * 1024 * 1024]) {
  test(`accepts canonical media at ${size} bytes on this runtime`, async () => {
    const base64 = Buffer.alloc(size, 0x41).toString("base64")
    for (const data of [base64, "data:image/png;base64," + base64]) {
      const result = await validate(data)
      assert.ok(Exit.isSuccess(result))
      assert.equal(result.value.bytes.byteLength, size)
    }
  })
}
test("rejects over-limit and malformed media as typed failures, never defects", async () => {
  for (const input of [
    Buffer.alloc(20 * 1024 * 1024 + 1),
    "AA A",
    "AA=A",
    "AB==",
    "data:image/jpeg;base64,AAAA",
    "data:image/png;base64,@@@@",
  ]) {
    const result = await validate(input)
    assert.ok(Exit.isFailure(result))
    assert.ok(JSON.stringify(result).includes("InvalidRequest"))
    assert.ok(!JSON.stringify(result).includes('"Defect"'))
  }
})

test("normalizes unexpected media validation exceptions into invalidRequest", async () => {
  const result = await Effect.runPromise(
    Effect.exit(
      ProviderShared.validateMedia(
        "test",
        {
          type: "media",
          mediaType: "image/png",
          get data(): string {
            throw new RangeError("private-image-payload")
          },
        },
        supported,
      ),
    ),
  )
  assert.ok(Exit.isFailure(result))
  assert.ok(JSON.stringify(result).includes("InvalidRequest"))
  assert.ok(!JSON.stringify(result).includes("private-image-payload"))
})

test("validates original stalled-session images offline", { skip: !process.env.MEDIA_REPLAY }, async () => {
  const media: Array<{ uri: string; mime: string }> = JSON.parse(readFileSync(process.env.MEDIA_REPLAY!, "utf8"))
  assert.equal(media.length, 2)
  for (const item of media) {
    const result = await Effect.runPromise(
      Effect.exit(
        ProviderShared.validateMedia(
          "replay",
          {
            type: "media",
            mediaType: item.mime,
            data: item.uri,
          },
          supported,
        ),
      ),
    )
    assert.ok(Exit.isSuccess(result))
  }
})
