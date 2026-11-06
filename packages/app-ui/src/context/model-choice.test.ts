import { expect, test } from "bun:test"
import { aliasModelVariant, groupModelChoices, modelVariantChoice, primaryProviderModel } from "./model-choice"

const model = (id: string, provider = "saved") => ({ id, name: id, provider: { id: provider }, variants: {} })

test("700 router aliases form one provider-specific row and preserve exact wire IDs", () => {
  const rows = groupModelChoices([
    model("router-model"),
    model("router-model:low"),
    model("router-model:high"),
    model("router-model:max"),
    model("router-model", "second"),
    model("router-model:medium", "second"),
    model("ordinary:free"),
    model("orphan:high"),
  ])
  expect(rows.map((row) => [row.provider.id, row.id])).toEqual([
    ["saved", "router-model"],
    ["second", "router-model"],
    ["saved", "ordinary:free"],
    ["saved", "orphan:high"],
  ])
  expect(modelVariantChoice(rows[0], "high")).toEqual({ modelID: "router-model:high", variant: null })
  expect(modelVariantChoice(rows[0], "medium")).toBeUndefined()
  expect(modelVariantChoice(rows[0], undefined)).toEqual({ modelID: "router-model", variant: null })
  expect(aliasModelVariant({ ...rows[0], id: "router-model:max" })).toBe("max")
  expect(modelVariantChoice(rows[1], "high")).toBeUndefined()
})

test("700 parameter variants retain their wire parameter and reject unsupported values", () => {
  const [row] = groupModelChoices([{ ...model("reasoner"), variants: { low: {}, high: {} } }])
  expect(modelVariantChoice(row, "high")).toEqual({ modelID: "reasoner", variant: "high" })
  expect(modelVariantChoice(row, "max")).toBeUndefined()
  expect(modelVariantChoice(row, undefined)).toEqual({ modelID: "reasoner", variant: null })
  expect(groupModelChoices([model("plain")])[0].reasoningModels).toBeUndefined()
})

test("701 alias-only catalogs remain one usable row without inventing a base wire ID", () => {
  const [row] = groupModelChoices([model("only:low"), model("only:high")])
  expect(row.reasoningDefault).toBe(false)
  expect(modelVariantChoice(row, "high")).toEqual({ modelID: "only:high", variant: null })
  expect(primaryProviderModel([{ id: "auto" }, { id: "auto:max" }, { id: "only:high" }, { id: "concrete" }])?.id).toBe(
    "concrete",
  )
  expect(primaryProviderModel([{ id: "only:high" }])?.id).toBe("only:high")
})

test("701 routers stay hidden", () => {
  expect(
    groupModelChoices([model("auto"), model("auto:high"), model("openrouter/auto"), model("gpt-6")]).map((m) => m.id),
  ).toEqual(["gpt-6"])
})
