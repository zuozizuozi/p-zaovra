import { expect, test } from "bun:test"
import path from "path"
import { OpenApi } from "effect/unstable/httpapi"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { generate } from "../../../sdk/js/script/generate"
import { tmpdir } from "../fixture/fixture"

test("legacy JS memory generation preserves explicit null and required body fields", async () => {
  await using tmp = await tmpdir()
  const spec = OpenApi.fromApi(PublicApi)
  const input = path.join(tmp.path, "openapi.json")
  const output = path.join(tmp.path, "generated")
  await Bun.write(input, JSON.stringify(spec))
  await generate(input, output)
  const types = await Bun.file(path.join(output, "types.gen.ts")).text()
  const sdk = await Bun.file(path.join(output, "sdk.gen.ts")).text()
  // Keep the actual artifacts when an explicitly isolated review directory is supplied.
  if (process.env.ZAOVRA_SDK_CONTRACT_EVIDENCE) {
    await Bun.write(path.join(process.env.ZAOVRA_SDK_CONTRACT_EVIDENCE, "openapi.json"), await Bun.file(input).text())
    await Bun.write(path.join(process.env.ZAOVRA_SDK_CONTRACT_EVIDENCE, "types.gen.ts"), types)
    await Bun.write(path.join(process.env.ZAOVRA_SDK_CONTRACT_EVIDENCE, "sdk.gen.ts"), sdk)
  }
  for (const name of ["GetPage", "Create", "Update", "GetAutomatic"]) {
    const response = types.split(`export type V2Memory${name}Responses =`)[1]?.split("export type")[0]
    expect(response, name).toMatch(/data: [^;\n]*\| null/)
  }
  expect(types.split("export type MemoryTidyTask =")[1]?.split("export type")[0]).toMatch(/finished: number \| null/)
  expect(types.split("export type MemoryAutomaticPreference =")[1]?.split("export type")[0]).toMatch(
    /currentRun: string \| null/,
  )
  const memory = sdk.split("export class Memory extends")[1]?.split("export class")[0]!
  for (const [method, fields] of [
    ["create", ["kind", "text"]],
    ["updatePage", ["summary", "body", "expected"]],
    ["disableAutomatic", ["expected"]],
  ] as const) {
    const signature = memory.split(`public ${method}<`)[1]?.split("const params")[0]!
    expect(signature, method).toContain("parameters: {")
    for (const field of fields) expect(signature, method + "." + field).toMatch(new RegExp(`\\b${field}:`))
  }
  expect(memory.split("public create<")[1]?.split("const params")[0]).toContain("layer?:")
  // Historical non-memory flat optionality is intentionally unchanged in this narrow fix.
  expect(sdk.split("public prompt<")[1]?.split("const params")[0]).toContain("prompt?:")
}, 120_000)
