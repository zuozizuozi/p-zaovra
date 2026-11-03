import { isRecord } from "../../utils/record"

// Gemini accepts a JSON Schema-like dialect for tool parameters, but rejects a
// handful of common JSON Schema shapes. Keep this projection isolated so the
// Gemini protocol file still reads like the other protocol modules.
const SCHEMA_INTENT_KEYS = [
  "type",
  "properties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "$ref",
  "additionalProperties",
  "patternProperties",
  "required",
  "not",
  "if",
  "then",
  "else",
]

const hasCombiner = (schema: unknown) =>
  isRecord(schema) && (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf) || Array.isArray(schema.allOf))

const hasSchemaIntent = (schema: unknown) =>
  isRecord(schema) && (hasCombiner(schema) || SCHEMA_INTENT_KEYS.some((key) => key in schema))

const sanitizeNode = (schema: unknown): unknown => {
  if (!isRecord(schema)) return Array.isArray(schema) ? schema.map(sanitizeNode) : schema

  const result: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "enum" && Array.isArray(value) ? value.map(String) : sanitizeNode(value),
    ]),
  )

  if (Array.isArray(result.enum) && (result.type === "integer" || result.type === "number")) result.type = "string"

  const properties = result.properties
  if (result.type === "object" && isRecord(properties) && Array.isArray(result.required)) {
    result.required = result.required.filter((field) => typeof field === "string" && field in properties)
  }

  if (result.type === "array" && !hasCombiner(result)) {
    result.items = result.items ?? {}
    if (isRecord(result.items) && !hasSchemaIntent(result.items)) result.items = { ...result.items, type: "string" }
  }

  if (typeof result.type === "string" && result.type !== "object" && !hasCombiner(result)) {
    delete result.properties
    delete result.required
  }

  return result
}

const emptyObjectSchema = (schema: Record<string, unknown>) =>
  schema.type === "object" &&
  (!isRecord(schema.properties) || Object.keys(schema.properties).length === 0) &&
  !schema.additionalProperties

// Gemini's Schema has no $ref/$defs, so inline local definitions to keep nested
// argument shapes visible. A recursive reference collapses to an open schema.
const inlineRefs = (schema: unknown, definitions: Record<string, unknown>, seen: ReadonlyArray<string>): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => inlineRefs(item, definitions, seen))
  if (!isRecord(schema)) return schema
  const siblings = Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "$ref" && key !== "$defs" && key !== "definitions")
      .map(([key, value]) => [key, inlineRefs(value, definitions, seen)]),
  )
  if (typeof schema.$ref !== "string") return siblings
  const name = schema.$ref.replace(/^#\/(\$defs|definitions)\//, "")
  if (seen.includes(name) || !isRecord(definitions[name])) return siblings
  return { ...(inlineRefs(definitions[name], definitions, [...seen, name]) as Record<string, unknown>), ...siblings }
}

const definitionsOf = (schema: unknown) =>
  isRecord(schema)
    ? { ...(isRecord(schema.definitions) ? schema.definitions : {}), ...(isRecord(schema.$defs) ? schema.$defs : {}) }
    : {}

const projectNode = (schema: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(schema)) return undefined
  if (emptyObjectSchema(schema)) return undefined
  const node = Object.fromEntries(
    [
      ["description", schema.description],
      ["required", schema.required],
      ["format", schema.format],
      ["type", Array.isArray(schema.type) ? schema.type.filter((type) => type !== "null")[0] : schema.type],
      ["nullable", Array.isArray(schema.type) && schema.type.includes("null") ? true : undefined],
      ["enum", schema.const !== undefined ? [schema.const] : schema.enum],
      [
        "properties",
        isRecord(schema.properties)
          ? Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, projectNode(value)]))
          : undefined,
      ],
      [
        "items",
        Array.isArray(schema.items)
          ? schema.items.map(projectNode)
          : schema.items === undefined
            ? undefined
            : projectNode(schema.items),
      ],
      [
        "anyOf",
        Array.isArray(schema.anyOf)
          ? schema.anyOf.map(projectNode)
          : Array.isArray(schema.oneOf)
            ? schema.oneOf.map(projectNode)
            : undefined,
      ],
      ["minLength", schema.minLength],
      ["maxLength", schema.maxLength],
      ["minimum", schema.minimum],
      ["maximum", schema.maximum],
    ].filter((entry) => entry[1] !== undefined),
  )
  // Schema has no allOf/oneOf fields and rejects unknown names; fold allOf
  // constraints into the node and offer oneOf branches as anyOf.
  return Array.isArray(schema.allOf) ? Object.assign({}, ...schema.allOf.map(projectNode), node) : node
}

export const convert = (schema: unknown) => projectNode(sanitizeNode(inlineRefs(schema, definitionsOf(schema), [])))

export * as GeminiToolSchema from "./gemini-tool-schema"
