export * as MCP from "./mcp"

import path from "path"
import { pathToFileURL } from "url"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"
import { Cause, Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import { Config } from "./config"
import { ConfigMCP } from "./config/mcp"
import { Credential } from "./credential"
import { makeLocationNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"
import { Location } from "./location"
import { Integration } from "./integration"
import { implementation, integrationID, methodID, oauthProvider } from "./mcp/oauth"
import { PermissionV2 } from "./permission"
import { SystemContext } from "./system-context"
import { SystemContextRegistry } from "./system-context/registry"
import { Tool } from "./tool/tool"
import { ToolRegistry } from "./tool/registry"
import { Tools } from "./tool/tools"

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_LIST_PAGES = 1_000
const CLIENT_OPTIONS = { capabilities: { roots: {} } } satisfies ClientOptions

export type Status =
  | { readonly status: "connected"; readonly tools: number }
  | { readonly status: "disabled" }
  | {
      readonly status: "needs_auth"
      readonly error: string
      readonly integrationID: Integration.ID
      readonly methodID: Integration.MethodID
    }
  | { readonly status: "failed"; readonly error: string }

const ServerInstructions = Schema.Struct({
  name: Schema.String,
  instructions: Schema.String,
  tools: Schema.Array(Schema.String),
})
export type ServerInstructions = typeof ServerInstructions.Type

export type Resource = {
  readonly name: string
  readonly uri: string
  readonly description?: string
  readonly mimeType?: string
  readonly client: string
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Readonly<Record<string, Status>>>
  readonly resources: () => Effect.Effect<Readonly<Record<string, Resource>>>
  readonly instructions: () => Effect.Effect<ReadonlyArray<ServerInstructions>>
  readonly reconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/MCP") {}

type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
type Server = typeof ConfigMCP.Server.Type
type Active = {
  readonly client: Client
  readonly transport: Transport
  readonly definitionNames: ReadonlyArray<string>
  registration: Scope.Closeable
}

const McpOutput = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  isError: Schema.Boolean.pipe(Schema.optional),
})
const McpStructured = Schema.Record(Schema.String, Schema.Unknown)

const ListServerInput = Schema.Struct({ server: Schema.String.pipe(Schema.optional) })
const ReadResourceInput = Schema.Struct({ server: Schema.String, uri: Schema.String })
const GetPromptInput = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const credentials = yield* Credential.Service
    const integrations = yield* Integration.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const systemContext = yield* SystemContextRegistry.Service
    const tools = yield* Tools.Service
    const parentScope = yield* Scope.Scope
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)
    const locks = KeyedMutex.makeUnsafe<string>()
    const entries = yield* config.entries()
    const configured = Config.latest(entries, "mcp")?.servers ?? {}
    const defaults = Config.latest(entries, "mcp")?.timeout
    const statuses: Record<string, Status> = {}
    const active = new Map<string, Active>()

    yield* integrations.transform((draft) => {
      Object.entries(configured).forEach(([name, server]) => {
        if (server.type !== "remote" || server.oauth === false) return
        draft.update(integrationID(name), (item) => {
          item.name = `MCP: ${name}`
        })
        draft.method.update(implementation(name, server))
      })
    })

    const close = Effect.fnUntraced(function* (name: string) {
      const current = active.get(name)
      active.delete(name)
      if (!current) return
      yield* Scope.close(current.registration, Exit.void).pipe(Effect.ignore)
      yield* Effect.tryPromise(() => current.client.close()).pipe(Effect.ignore)
    })

    const refresh = Effect.fn("MCP.refresh")(function* (serverName: string, client: Client, server: Server) {
      const definitions = client.getServerCapabilities()?.tools
        ? yield* listAll((cursor) =>
            Effect.tryPromise({
              try: () =>
                client.listTools(cursor ? { cursor } : undefined, {
                  timeout: server.timeout?.request ?? defaults?.request ?? DEFAULT_REQUEST_TIMEOUT_MS,
                }),
              catch: normalizeError,
            }),
          ).pipe(Effect.map((pages) => pages.flatMap((page) => page.tools)))
        : []
      const registered: Record<string, Tool.AnyTool> = {}
      const names: string[] = []
      for (const definition of definitions) {
        const toolName = uniqueToolName(registered, serverToolName(serverName, definition.name), definition.name)
        registered[toolName] = canonicalTool(toolName, server, definition, client, permission, defaults?.request)
        names.push(toolName)
      }

      const registration = yield* Scope.fork(parentScope)
      yield* tools.register(registered).pipe(
        Scope.provide(registration),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(registration, exit) : Effect.void)),
      )
      const previous = active.get(serverName)
      if (!previous) return yield* Effect.die(`MCP server disappeared while refreshing: ${serverName}`)
      active.set(serverName, { ...previous, definitionNames: names, registration })
      if (previous) yield* Scope.close(previous.registration, Exit.void).pipe(Effect.ignore)
      statuses[serverName] = { status: "connected", tools: names.length }
    })

    const markClosed = (name: string, client: Client) =>
      locks.withLock(name)(
        Effect.gen(function* () {
          const current = active.get(name)
          if (current?.client !== client) return
          active.delete(name)
          yield* Scope.close(current.registration, Exit.void).pipe(Effect.ignore)
          statuses[name] = { status: "failed", error: "Connection closed" }
        }),
      )

    const watch = (name: string, client: Client, server: Server) => {
      client.onclose = () => {
        runFork(markClosed(name, client))
      }
      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        runFork(
          locks.withLock(name)(
            Effect.gen(function* () {
              if (active.get(name)?.client !== client) return
              yield* refresh(name, client, server)
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to refresh MCP tools", {
                  server: name,
                  error: normalizeError(error).message,
                }),
              ),
            ),
          ),
        )
      })
    }

    const connect = Effect.fn("MCP.connect")(function* (name: string, server: Server, force = false) {
      yield* close(name)
      if (server.disabled && !force) {
        statuses[name] = { status: "disabled" }
        return
      }

      const authentication = server.type === "remote" && server.oauth !== false
      const connection = authentication ? yield* integrations.connection.active(integrationID(name)) : undefined
      const resolved = connection
        ? yield* integrations.connection.resolve(connection).pipe(Effect.exit)
        : Exit.succeed(undefined)
      if (Exit.isFailure(resolved)) {
        statuses[name] = authStatus(name, normalizeError(Cause.squash(resolved.cause)).message)
        return
      }
      const credentialID = connection?.type === "credential" ? connection.id : undefined
      const authProvider =
        authentication && resolved.value?.type === "oauth"
          ? oauthProvider(
              server,
              resolved.value,
              credentialID ? (value) => runPromise(credentials.update(credentialID, { value })) : undefined,
            )
          : undefined
      const connected = yield* connectServer(location, server, defaults?.startup, authProvider).pipe(Effect.exit)
      if (Exit.isFailure(connected)) {
        const error = normalizeError(Cause.squash(connected.cause))
        statuses[name] =
          authentication && (error instanceof UnauthorizedError || /unauthorized|oauth/i.test(error.message))
            ? authStatus(name, error.message)
            : { status: "failed", error: error.message }
        return
      }

      const { client, transport } = connected.value
      active.set(name, {
        client,
        transport,
        definitionNames: [],
        registration: yield* Scope.fork(parentScope),
      })
      const loaded = yield* refresh(name, client, server).pipe(Effect.exit)
      if (Exit.isFailure(loaded)) {
        yield* close(name)
        statuses[name] = { status: "failed", error: normalizeError(Cause.squash(loaded.cause)).message }
        return
      }
      const current = active.get(name)
      if (current) active.set(name, { ...current, transport })
      watch(name, client, server)
    })

    const reconnect = Effect.fn("MCP.reconnect")(function* (name: string) {
      const server = configured[name]
      if (!server) return yield* new NotFoundError({ name })
      yield* locks.withLock(name)(connect(name, server, true))
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      if (!configured[name]) return yield* new NotFoundError({ name })
      yield* locks.withLock(name)(
        close(name).pipe(
          Effect.andThen(
            Effect.sync(() => {
              statuses[name] = { status: "disabled" }
            }),
          ),
        ),
      )
    })

    yield* registerCatalogTools(tools, active, permission, defaults?.request).pipe(Effect.orDie)
    yield* systemContext.register({
      key: SystemContext.Key.make("core/mcp"),
      load: Effect.sync(() => mcpInstructionsContext(active)),
    })
    yield* Effect.forEach(Object.entries(configured), ([name, server]) => locks.withLock(name)(connect(name, server)), {
      concurrency: "unbounded",
      discard: true,
    })
    yield* Effect.addFinalizer(() => Effect.forEach(active.keys(), close, { concurrency: "unbounded", discard: true }))

    return Service.of({
      status: Effect.fn("MCP.status")(function* () {
        return { ...statuses }
      }),
      resources: Effect.fn("MCP.resources")(function* () {
        const resources = yield* Effect.forEach(
          active,
          ([clientName, item]) =>
            item.client.getServerCapabilities()?.resources
              ? listAll((cursor) =>
                  Effect.tryPromise({
                    try: () =>
                      item.client.listResources(cursor ? { cursor } : undefined, { timeout: defaults?.request }),
                    catch: normalizeError,
                  }),
                ).pipe(
                  Effect.map((pages) =>
                    pages.flatMap((page) =>
                      page.resources.map((resource) => ({
                        name: resource.name,
                        uri: resource.uri,
                        description: resource.description,
                        mimeType: resource.mimeType,
                        client: clientName,
                      })),
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.logWarning("failed to list MCP resources", {
                      server: clientName,
                      error: error.message,
                    }).pipe(Effect.as([] as Resource[])),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: "unbounded" },
        )
        return Object.fromEntries(resources.flat().map((resource) => [`${resource.client}:${resource.uri}`, resource]))
      }),
      instructions: Effect.fn("MCP.instructions")(function* () {
        return Array.from(active, ([name, item]) => ({
          name,
          instructions: item.client.getInstructions()?.trim() ?? "",
          tools: item.definitionNames,
        })).filter((item) => item.instructions.length > 0)
      }),
      reconnect,
      disconnect,
    })
  }),
)

function connectServer(
  location: Location.Interface,
  server: Server,
  fallback?: number,
  authProvider?: OAuthClientProvider,
) {
  const startup = server.timeout?.startup ?? fallback ?? DEFAULT_STARTUP_TIMEOUT_MS
  if (server.type === "local") {
    const command = server.command[0]
    if (!command) return Effect.fail(new Error("Local MCP command cannot be empty"))
    const transport = new StdioClientTransport({
      command,
      args: server.command.slice(1),
      cwd: server.cwd ? path.resolve(location.directory, server.cwd) : location.directory,
      env: { ...getDefaultEnvironment(), ...server.environment },
      stderr: "pipe",
    })
    return connectTransport(location, transport, startup)
  }

  if (!URL.canParse(server.url)) return Effect.fail(new Error(`Invalid MCP URL: ${server.url}`))
  const url = new URL(server.url)
  const options = {
    ...(authProvider ? { authProvider } : {}),
    ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
  }
  return connectTransport(location, new StreamableHTTPClientTransport(url, options), startup).pipe(
    Effect.catch((first) => {
      if (first instanceof UnauthorizedError || /unauthorized|oauth/i.test(first.message)) return Effect.fail(first)
      return connectTransport(location, new SSEClientTransport(url, options), startup)
    }),
  )
}

function connectTransport(location: Location.Interface, transport: Transport, timeout: number) {
  const client = new Client({ name: "zaovra", version: "1.18.3" }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(location.directory).href }] }),
  )
  return Effect.tryPromise({
    try: () => client.connect(transport, { timeout }).then(() => ({ client, transport })),
    catch: normalizeError,
  }).pipe(Effect.onError(() => Effect.tryPromise(() => client.close()).pipe(Effect.ignore)))
}

function canonicalTool(
  name: string,
  server: Server,
  definition: MCPTool,
  client: Client,
  permission: PermissionV2.Interface,
  fallback?: number,
) {
  return Tool.make({
    description: definition.description ?? `Call ${definition.name} on an MCP server`,
    input: Schema.Record(Schema.String, Schema.Unknown),
    inputJsonSchema: definition.inputSchema,
    output: McpOutput,
    structured: McpStructured,
    toStructuredOutput: ({ output }) => output.structuredContent ?? {},
    toModelOutput: ({ output }) => output.content.flatMap(modelContent),
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* permission
          .assert({
            action: name,
            resources: ["*"],
            save: ["*"],
            metadata: { mcpTool: definition.name },
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
          })
          .pipe(Effect.mapError(() => new Tool.Failure({ message: `Permission denied: ${name}` })))
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            client.callTool({ name: definition.name, arguments: input }, CallToolResultSchema, {
              signal,
              timeout: server.timeout?.request ?? fallback ?? DEFAULT_REQUEST_TIMEOUT_MS,
              resetTimeoutOnProgress: true,
              onprogress: () => {},
            }),
          catch: (error) => new Tool.Failure({ message: normalizeError(error).message }),
        })
        if (result.isError) return yield* new Tool.Failure({ message: errorContent(result.content) })
        return {
          content: result.content,
          structuredContent: result.structuredContent,
          isError: result.isError,
        }
      }),
  })
}

function registerCatalogTools(
  tools: Tools.Interface,
  active: Map<string, Active>,
  permission: PermissionV2.Interface,
  timeout?: number,
) {
  const permitted = (context: Tool.Context, resources: ReadonlyArray<string>) =>
    permission
      .assert({
        action: "read",
        resources,
        save: resources.map((resource) => resource.replace(/:[^:]*$/, ":*")),
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID },
      })
      .pipe(Effect.mapError(() => new Tool.Failure({ message: "Permission denied: MCP resources" })))

  return tools.register({
    list_mcp_resources: Tool.make({
      description: "List resources exposed by connected MCP servers.",
      input: ListServerInput,
      output: Schema.String,
      execute: (input, context) =>
        Effect.gen(function* () {
          const clients = selectedClients(active, input.server)
          yield* permitted(
            context,
            clients.map(([name]) => `mcp:${name}:*`),
          )
          const resources = yield* Effect.forEach(
            clients,
            ([server, item]) =>
              item.client.getServerCapabilities()?.resources
                ? listAll((cursor) =>
                    Effect.tryPromise({
                      try: () => item.client.listResources(cursor ? { cursor } : undefined, { timeout }),
                      catch: normalizeError,
                    }),
                  ).pipe(
                    Effect.map((pages) =>
                      pages.flatMap((page) => page.resources.map((resource) => ({ ...resource, server }))),
                    ),
                  )
                : Effect.succeed([]),
            { concurrency: "unbounded" },
          )
          return JSON.stringify({ resources: resources.flat() }, null, 2)
        }).pipe(Effect.mapError(toolFailure)),
    }),
    list_mcp_resource_templates: Tool.make({
      description: "List resource templates exposed by connected MCP servers.",
      input: ListServerInput,
      output: Schema.String,
      execute: (input, context) =>
        Effect.gen(function* () {
          const clients = selectedClients(active, input.server)
          yield* permitted(
            context,
            clients.map(([name]) => `mcp:${name}:*`),
          )
          const templates = yield* Effect.forEach(
            clients,
            ([server, item]) =>
              item.client.getServerCapabilities()?.resources
                ? listAll((cursor) =>
                    Effect.tryPromise({
                      try: () => item.client.listResourceTemplates(cursor ? { cursor } : undefined, { timeout }),
                      catch: normalizeError,
                    }),
                  ).pipe(
                    Effect.map((pages) =>
                      pages.flatMap((page) => page.resourceTemplates.map((template) => ({ ...template, server }))),
                    ),
                  )
                : Effect.succeed([]),
            { concurrency: "unbounded" },
          )
          return JSON.stringify({ resourceTemplates: templates.flat() }, null, 2)
        }).pipe(Effect.mapError(toolFailure)),
    }),
    read_mcp_resource: Tool.make({
      description: "Read a resource from a connected MCP server using its exact URI.",
      input: ReadResourceInput,
      output: Schema.String,
      execute: (input, context) =>
        Effect.gen(function* () {
          const item = active.get(input.server)
          if (!item) return yield* new Tool.Failure({ message: `MCP server is not connected: ${input.server}` })
          yield* permitted(context, [`mcp:${input.server}:${input.uri}`])
          const result = yield* Effect.tryPromise({
            try: () => item.client.readResource({ uri: input.uri }, { timeout }),
            catch: (error) => new Tool.Failure({ message: normalizeError(error).message }),
          })
          return JSON.stringify(result, null, 2)
        }),
    }),
    list_mcp_prompts: Tool.make({
      description: "List reusable prompts exposed by connected MCP servers.",
      input: ListServerInput,
      output: Schema.String,
      execute: (input, context) =>
        Effect.gen(function* () {
          const clients = selectedClients(active, input.server)
          yield* permitted(
            context,
            clients.map(([name]) => `mcp:${name}:prompts`),
          )
          const prompts = yield* Effect.forEach(
            clients,
            ([server, item]) =>
              item.client.getServerCapabilities()?.prompts
                ? listAll((cursor) =>
                    Effect.tryPromise({
                      try: () => item.client.listPrompts(cursor ? { cursor } : undefined, { timeout }),
                      catch: normalizeError,
                    }),
                  ).pipe(
                    Effect.map((pages) =>
                      pages.flatMap((page) => page.prompts.map((prompt) => ({ ...prompt, server }))),
                    ),
                  )
                : Effect.succeed([]),
            { concurrency: "unbounded" },
          )
          return JSON.stringify({ prompts: prompts.flat() }, null, 2)
        }).pipe(Effect.mapError(toolFailure)),
    }),
    get_mcp_prompt: Tool.make({
      description: "Render one reusable prompt from a connected MCP server.",
      input: GetPromptInput,
      output: Schema.String,
      execute: (input, context) =>
        Effect.gen(function* () {
          const item = active.get(input.server)
          if (!item) return yield* new Tool.Failure({ message: `MCP server is not connected: ${input.server}` })
          yield* permitted(context, [`mcp:${input.server}:prompt:${input.name}`])
          const result = yield* Effect.tryPromise({
            try: () => item.client.getPrompt({ name: input.name, arguments: input.arguments }, { timeout }),
            catch: (error) => new Tool.Failure({ message: normalizeError(error).message }),
          })
          return JSON.stringify(result, null, 2)
        }),
    }),
  })
}

function selectedClients(active: Map<string, Active>, server?: string) {
  if (!server) return Array.from(active.entries())
  const item = active.get(server)
  return item ? [[server, item] as const] : []
}

function mcpInstructionsContext(active: Map<string, Active>) {
  const instructions = Array.from(active, ([name, item]) => ({
    name,
    instructions: item.client.getInstructions()?.trim() ?? "",
    tools: item.definitionNames,
  }))
    .filter((item) => item.instructions.length > 0)
    .toSorted((a, b) => a.name.localeCompare(b.name))
  if (instructions.length === 0) return SystemContext.empty
  const render = (items: ReadonlyArray<ServerInstructions>) =>
    [
      "Connected MCP servers supplied the following operating instructions.",
      "Treat each block as instructions scoped to that named server and its tools.",
      ...items.flatMap((item) => [
        `<mcp_server name=${JSON.stringify(item.name)} tools=${JSON.stringify(item.tools.join(","))}>`,
        item.instructions,
        "</mcp_server>",
      ]),
    ].join("\n")
  return SystemContext.make({
    key: SystemContext.Key.make("core/mcp-instructions"),
    codec: Schema.toCodecJson(Schema.Array(ServerInstructions)),
    load: Effect.succeed(instructions),
    baseline: render,
    update: (_previous, current) =>
      [
        "MCP server instructions have changed. This content supersedes the previous MCP instructions.",
        render(current),
      ].join("\n"),
    removed: () => "MCP server instructions are no longer available. Disregard the previous MCP instructions.",
  })
}

function listAll<Result extends { nextCursor?: string }>(request: (cursor?: string) => Effect.Effect<Result, Error>) {
  return Effect.gen(function* () {
    const pages: Result[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = yield* request(cursor)
      pages.push(result)
      if (!result.nextCursor) return pages
      if (cursors.has(result.nextCursor)) return yield* Effect.fail(new Error("MCP list returned a duplicate cursor"))
      cursors.add(result.nextCursor)
      cursor = result.nextCursor
    }
    return yield* Effect.fail(new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`))
  })
}

function serverToolName(server: string, tool: string) {
  const value = `mcp_${sanitize(server)}_${sanitize(tool)}`
  if (value.length <= 64) return value
  return `${value.slice(0, 51)}_${hash(value).slice(0, 12)}`
}

function uniqueToolName(tools: Readonly<Record<string, Tool.AnyTool>>, name: string, source: string) {
  if (!tools[name]) return name
  return `${name.slice(0, 51)}_${hash(source).slice(0, 12)}`
}

function sanitize(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_")
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function modelContent(value: unknown): ReadonlyArray<Tool.Content> {
  if (!isRecord(value) || typeof value.type !== "string") return []
  if (value.type === "text" && typeof value.text === "string") return [{ type: "text", text: value.text }]
  if ((value.type === "image" || value.type === "audio") && typeof value.data === "string")
    return [{ type: "file", data: value.data, mime: stringValue(value.mimeType) ?? "application/octet-stream" }]
  if (value.type === "resource" && isRecord(value.resource)) {
    if (typeof value.resource.text === "string") return [{ type: "text", text: value.resource.text }]
    if (typeof value.resource.blob === "string")
      return [
        {
          type: "file",
          data: value.resource.blob,
          mime: stringValue(value.resource.mimeType) ?? "application/octet-stream",
          name: stringValue(value.resource.uri),
        },
      ]
  }
  if (value.type === "resource_link" && typeof value.uri === "string")
    return [{ type: "text", text: `MCP resource: ${value.uri}` }]
  return []
}

function errorContent(content: ReadonlyArray<unknown>) {
  return (
    content
      .flatMap(modelContent)
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n\n") || "MCP tool returned an error"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function normalizeError(error: unknown) {
  if (error instanceof Error) return error
  if (isRecord(error) && error._tag === "Some" && "value" in error) return normalizeError(error.value)
  return new Error(String(error))
}

function authStatus(name: string, error: string): Status {
  return {
    status: "needs_auth",
    error,
    integrationID: integrationID(name),
    methodID,
  }
}

function toolFailure(error: Error | Tool.Failure) {
  return error instanceof Tool.Failure ? error : new Tool.Failure({ message: error.message })
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Config.node,
    Credential.node,
    Integration.node,
    Location.node,
    PermissionV2.node,
    SystemContextRegistry.node,
    ToolRegistry.toolsNode,
  ],
})
