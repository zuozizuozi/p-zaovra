import path from "path"
import { fileURLToPath } from "url"
import ts from "typescript"
import { createClient } from "@hey-api/openapi-ts"

const dir = fileURLToPath(new URL("..", import.meta.url))

export async function generate(input: string, output: string) {
  const document = (await Bun.file(input).json()) as MemoryDocument & {
    components?: { schemas?: Record<string, unknown> }
    [key: string]: unknown
  }
  const schemas = document.components?.schemas
  if (schemas) {
    const reachable = new Set<string>()
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (typeof value !== "object" || value === null) return
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
          const name = child.slice("#/components/schemas/".length)
          if (reachable.has(name)) continue
          reachable.add(name)
          visit(schemas[name])
        } else {
          visit(child)
        }
      }
    }
    visit({ ...document, components: { ...document.components, schemas: undefined } })
    for (const name of Object.keys(schemas)) {
      if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
    }
    await Bun.write(input, JSON.stringify(document))
  }

  await createClient({
    input,
    output: {
      path: output,
      tsConfigPath: path.join(dir, "tsconfig.json"),
      clean: true,
    },
    plugins: [
      {
        name: "@hey-api/typescript",
        exportFromIndex: false,
      },
      {
        name: "@hey-api/sdk",
        instance: "ZaovraClient",
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      {
        name: "@hey-api/client-fetch",
        exportFromIndex: false,
        baseUrl: "http://localhost:4096",
      },
    ],
  })

  const generatedTypes = await Bun.file(path.join(output, "types.gen.ts")).text()
  if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
    throw new Error("Session history generated duplicate Session event variants")
  }
  const historyTypesPatched = generatedTypes.replace(
    /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
    "$1number$2number",
  )
  if (historyTypesPatched === generatedTypes) {
    throw new Error("Session history numeric query patch did not apply")
  }
  await Bun.write(path.join(output, "types.gen.ts"), historyTypesPatched)

  const generatedSdk = await Bun.file(path.join(output, "sdk.gen.ts")).text()
  const historySdkPatched = generatedSdk.replace(
    /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
    "$1number$2number",
  )
  if (historySdkPatched === generatedSdk) {
    throw new Error("Session history numeric SDK patch did not apply")
  }
  await Bun.write(path.join(output, "sdk.gen.ts"), memoryParameters(historySdkPatched, document))

  // Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
  // endpoint's TError into the second generic of ServerSentEventsResult, which
  // is the AsyncGenerator's TReturn slot. Iterator return values have nothing
  // to do with HTTP errors, and any consumer that calls `.return()` or returns
  // from a mock generator gets type-checked against the wrong shape. Drop the
  // arg so TReturn defaults to void.
  const sseTypesPath = path.join(output, "client/types.gen.ts")
  const sseTypesFile = Bun.file(sseTypesPath)
  const sseTypesSource = await sseTypesFile.text()
  const sseTypesPatched = sseTypesSource.replace(
    "=> Promise<ServerSentEventsResult<TData, TError>>",
    "=> Promise<ServerSentEventsResult<TData>>",
  )
  if (sseTypesPatched === sseTypesSource) {
    throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
  }
  await Bun.write(sseTypesPath, sseTypesPatched)
}

type MemoryDocument = {
  paths?: Record<
    string,
    Record<
      string,
      {
        operationId?: string
        parameters?: { name: string }[]
        requestBody?: {
          required?: boolean
          content?: Record<
            string,
            {
              schema?: {
                type?: string
                properties?: Record<string, unknown>
                required?: string[]
              }
            }
          >
        }
      }
    >
  >
}

// openapi-ts 0.90.10 reads required from each child instead of the body object.
// Limit the compatibility correction to memory; keep every other legacy signature intact.
export function memoryParameters(source: string, document: MemoryDocument) {
  const file = ts.createSourceFile("sdk.gen.ts", source, ts.ScriptTarget.Latest, true)
  const memory = file.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "Memory")
  if (!memory || !ts.isClassDeclaration(memory)) throw new Error("Generated Memory SDK class is missing")
  const edits: number[] = []
  for (const operation of Object.values(document.paths ?? {}).flatMap((item) => Object.values(item))) {
    if (!operation.operationId?.startsWith("v2.memory.")) continue
    const body = operation.requestBody
    const schema = body?.content?.["application/json"]?.schema
    if (!body?.required || schema?.type !== "object" || !schema.properties || !schema.required?.length) continue
    const name = operation.operationId.slice("v2.memory.".length)
    const method = memory.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(file) === name)
    if (!method || !ts.isMethodDeclaration(method)) throw new Error(`Memory SDK method is missing: ${name}`)
    const parameter = method.parameters[0]
    if (!parameter?.type || !ts.isTypeLiteralNode(parameter.type))
      throw new Error(`Memory SDK parameters changed: ${name}`)
    for (const key of schema.required) {
      const field = operation.parameters?.some((item) => item.name === key) ? `body_${key}` : key
      const member = parameter.type.members.find(
        (node) => ts.isPropertySignature(node) && node.name.getText(file).replace(/^["']|["']$/g, "") === field,
      )
      if (!member || !ts.isPropertySignature(member)) throw new Error(`Memory SDK field is missing: ${name}.${field}`)
      if (member.questionToken) edits.push(member.questionToken.getStart(file))
    }
    if (parameter.questionToken) edits.push(parameter.questionToken.getStart(file))
  }
  return edits
    .sort((a, b) => b - a)
    .reduce((text, position) => text.slice(0, position) + text.slice(position + 1), source)
}
