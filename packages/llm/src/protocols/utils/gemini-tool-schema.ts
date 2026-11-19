import { isRecord } from "../../utils/record"
import { referenceAnnotations, resolveLocalReference, UnsupportedToolSchema } from "./tool-schema-reference"

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

const annotationKeys = new Set(["title", "description", "default", "example", "examples", "$comment", "$schema"])
const schemaChildren = new Set([
  "items",
  "prefixItems",
  "anyOf",
  "oneOf",
  "allOf",
  "additionalProperties",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
])
const schemaMaps = new Set(["properties", "patternProperties", "dependentSchemas"])
const scalarConstraints = new Set(["type", "description", "format", "minLength", "maxLength", "minimum", "maximum"])

// Inline the fields Gemini can advertise without altering annotation data or the
// names of properties. Use the root document, including escaped pointer keys.
function inlineRefs(schema: unknown, root: Record<string, unknown>, seen: ReadonlySet<string>): unknown {
  if (Array.isArray(schema)) return schema.map((child) => inlineRefs(child, root, seen))
  if (!isRecord(schema)) return schema
  if (schema !== root && Object.hasOwn(schema, "$id"))
    throw new UnsupportedToolSchema("a nested schema changes the base identifier")
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalReference(root, schema.$ref, seen)
    const target = inlineRefs(resolved.target, root, resolved.active)
    if (!isRecord(target)) throw new UnsupportedToolSchema("schema reference must resolve to a schema object")
    return { ...target, ...referenceAnnotations(schema, resolved.target) }
  }
  const node = Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === "$defs" || key === "definitions") return []
      if (schemaMaps.has(key) && isRecord(value))
        return [
          [
            key,
            Object.fromEntries(Object.entries(value).map(([name, child]) => [name, inlineRefs(child, root, seen)])),
          ],
        ]
      return [[key, schemaChildren.has(key) ? inlineRefs(value, root, seen) : value]]
    }),
  )
  return foldObjectIntersection(node)
}

function foldObjectIntersection(node: Record<string, unknown>) {
  if (!Array.isArray(node.allOf)) return node
  const { allOf: branches, ...siblings } = node
  const isObject = (schema: unknown) =>
    isRecord(schema) && (schema.type === "object" || "properties" in schema || "required" in schema)
  if (![...branches, siblings].some(isObject)) return node

  const properties = new Map<string, Record<string, unknown>>()
  const required = new Set<string>()
  const merged: Record<string, unknown> = {}
  for (const fragment of [...branches, siblings]) {
    if (fragment === true) continue
    if (!isRecord(fragment))
      throw new UnsupportedToolSchema("Gemini cannot project a non-object branch in an object intersection")
    for (const [key, value] of Object.entries(fragment)) {
      if (key === "properties" && isRecord(value)) {
        for (const [name, schema] of Object.entries(value)) {
          if (!isRecord(schema))
            throw new UnsupportedToolSchema(
              "Gemini cannot project a non-object property schema in an object intersection",
            )
          const previous = properties.get(name)
          if (previous && JSON.stringify(previous) !== JSON.stringify(schema)) {
            const compatible =
              Object.keys(previous).every((key) => scalarConstraints.has(key)) &&
              Object.entries(schema).every(
                ([key, value]) =>
                  scalarConstraints.has(key) &&
                  (!Object.hasOwn(previous, key) || JSON.stringify(previous[key]) === JSON.stringify(value)),
              )
            if (!compatible)
              throw new UnsupportedToolSchema(
                "Gemini cannot project different constraints on the same property in an object intersection",
              )
          }
          properties.set(name, { ...previous, ...schema })
        }
        continue
      }
      if (key === "required" && Array.isArray(value) && value.every((name) => typeof name === "string")) {
        for (const name of value) required.add(name)
        continue
      }
      if (key === "type" && value === "object") {
        merged.type = value
        continue
      }
      if (key === "additionalProperties" && value === true) continue
      if (annotationKeys.has(key)) {
        merged[key] = value
        continue
      }
      if (key === "minProperties" && typeof value === "number") {
        merged.minProperties = Math.max(typeof merged.minProperties === "number" ? merged.minProperties : 0, value)
        continue
      }
      if (key === "maxProperties" && typeof value === "number") {
        merged.maxProperties = Math.min(typeof merged.maxProperties === "number" ? merged.maxProperties : value, value)
        continue
      }
      throw new UnsupportedToolSchema(`Gemini cannot project "${key}" in an object intersection`)
    }
  }
  if (properties.size === 0 && (merged.minProperties !== undefined || merged.maxProperties !== undefined))
    throw new UnsupportedToolSchema(
      "Gemini cannot project property counts without declared properties in an object intersection",
    )
  if (
    typeof merged.minProperties === "number" &&
    typeof merged.maxProperties === "number" &&
    merged.minProperties > merged.maxProperties
  )
    throw new UnsupportedToolSchema("Gemini cannot project conflicting property counts in an object intersection")
  if ([...required].some((name) => !properties.has(name)))
    throw new UnsupportedToolSchema(
      "Gemini cannot project a required property without a declaration in an object intersection",
    )
  return {
    ...merged,
    properties: Object.fromEntries(properties),
    ...(required.size ? { required: [...required] } : {}),
  }
}

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
      ["minProperties", schema.minProperties],
      ["maxProperties", schema.maxProperties],
      ["minimum", schema.minimum],
      ["maximum", schema.maximum],
    ].filter((entry) => entry[1] !== undefined),
  )
  // Schema has no allOf/oneOf fields and rejects unknown names; fold allOf
  // constraints into the node and offer oneOf branches as anyOf.
  return Array.isArray(schema.allOf) ? Object.assign({}, ...schema.allOf.map(projectNode), node) : node
}

export const convert = (schema: unknown) =>
  isRecord(schema) ? projectNode(sanitizeNode(inlineRefs(schema, schema, new Set()))) : undefined

export * as GeminiToolSchema from "./gemini-tool-schema"
