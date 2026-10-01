import type { JsonSchema, ModelToolSchemaCompatibility } from "../../schema"
import { isRecord } from "../../utils/record"
import { GeminiToolSchema } from "./gemini-tool-schema"

const removeNullSchemas = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeNullSchemas)
  if (!isRecord(value)) return value
  const fields = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "anyOf")
      .map(([key, field]) => [key, removeNullSchemas(field)]),
  )
  if (!Array.isArray(value.anyOf)) return fields
  const variants = value.anyOf.filter((variant) => !isRecord(variant) || variant.type !== "null").map(removeNullSchemas)
  if (variants.length === 1 && isRecord(variants[0])) return { ...fields, ...variants[0] }
  return { ...fields, anyOf: variants }
}

const tupleItemsSchema = (items: ReadonlyArray<unknown>) => {
  const projected = items.map(moonshotNode)
  if (projected.length === 0) return {}
  if (projected.length === 1) return projected[0]
  return { anyOf: projected }
}

const moonshotNode = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(moonshotNode)
  if (!isRecord(schema)) return schema
  if (typeof schema.$ref === "string") return { $ref: schema.$ref }
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === "items" && Array.isArray(value)) return [[key, tupleItemsSchema(value)]]
      if (key === "prefixItems") {
        if ("items" in schema) return []
        return [["items", tupleItemsSchema(Array.isArray(value) ? value : [])]]
      }
      if (key === "unevaluatedItems") return []
      return [[key, moonshotNode(value)]]
    }),
  )
}

const moonshot = (schema: JsonSchema): JsonSchema => {
  const projected = moonshotNode(schema)
  return isRecord(projected) ? projected : {}
}

const openAI = (schema: JsonSchema): JsonSchema => {
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isRecord) : []
  const flattened =
    variants.length === 0
      ? { ...schema, type: "object" }
      : {
          ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf")),
          type: "object",
          properties: Object.fromEntries(
            [
              ...new Set(
                variants.flatMap((variant) => Object.keys(isRecord(variant.properties) ? variant.properties : {})),
              ),
            ].map((key) => [
              key,
              mergePropertySchemas(
                variants.flatMap((variant) =>
                  isRecord(variant.properties) && key in variant.properties ? [variant.properties[key]] : [],
                ),
              ),
            ]),
          ),
          ...commonRequired(variants),
          additionalProperties: false,
        }
  const normalized = removeNullSchemas(flattened)
  return isRecord(normalized) ? normalized : { type: "object" }
}

function mergePropertySchemas(schemas: unknown[]) {
  const unique = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()]
  if (unique.length === 1) return unique[0]
  // Only collapse plain string literals/enums; retain annotated or constrained alternatives intact.
  if (
    unique.every(
      (schema) =>
        isRecord(schema) &&
        Object.keys(schema).every((key) => ["type", "enum", "const"].includes(key)) &&
        (schema.type === undefined || schema.type === "string") &&
        (typeof schema.const === "string" ||
          (Array.isArray(schema.enum) &&
            schema.enum.length > 0 &&
            schema.enum.every((value) => typeof value === "string"))),
    )
  ) {
    return {
      type: "string",
      enum: [
        ...new Set(
          unique.flatMap((schema) =>
            isRecord(schema) ? (typeof schema.const === "string" ? [schema.const] : (schema.enum as string[])) : [],
          ),
        ),
      ],
    }
  }
  return { anyOf: unique }
}

function commonRequired(variants: Record<string, unknown>[]) {
  const required = Array.isArray(variants[0]?.required)
    ? variants[0].required.filter(
        (key) =>
          typeof key === "string" &&
          variants.every((variant) => Array.isArray(variant.required) && variant.required.includes(key)),
      )
    : []
  // Branch-specific requirements remain enforced by the original host schema.
  return required.length > 0 ? { required } : {}
}

const gemini = (schema: JsonSchema): JsonSchema => GeminiToolSchema.convert(schema) ?? {}

const modelCompatibility = (
  schema: JsonSchema,
  compatibility: ModelToolSchemaCompatibility | undefined,
): JsonSchema => {
  if (compatibility === undefined) return schema
  switch (compatibility) {
    case "gemini":
      return gemini(schema)
    case "moonshot":
      return moonshot(schema)
  }
}

export const ToolSchemaProjection = {
  gemini,
  modelCompatibility,
  moonshot,
  openAI,
} as const
