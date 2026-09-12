import type { Page, Route } from "@playwright/test"
import type { Message, Part, ProviderListResponse, SessionMessage } from "@zaovra-ai/sdk/v2/client"

const emptyList = new Set(["/skill", "/command", "/lsp", "/formatter", "/vcs/status", "/vcs/diff"])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/experimental/resource"])

export interface MockServerConfig {
  provider: unknown
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  vcsDiff?: unknown[]
  messageDelay?: number
  beforeMessagesResponse?: (input: { sessionID: string; before?: string }) => Promise<void>
  onMessages?: (input: { sessionID: string; before?: string; phase: "start" | "end" }) => void
  message?: (sessionID: string, messageID: string) => unknown
  onMessage?: (input: { sessionID: string; messageID: string }) => void
  events?: () => unknown[]
  eventRetry?: number
  todos?: (sessionID: string) => unknown[]
  permissions?: unknown[] | (() => unknown[])
  questions?: unknown[] | (() => unknown[])
  fileList?: (path: string) => unknown | Promise<unknown>
  fileContent?: (path: string) => unknown | Promise<unknown>
  findFiles?: (input: { query: string; dirs?: string; limit?: number }) => unknown
  sessionStatus?: unknown
}

export async function mockZaovraServer(page: Page, config: MockServerConfig) {
  const cursors = new Map<string, string>()
  let nextCursor = 0
  const catalog = config.provider as Partial<ProviderListResponse>
  const available = (catalog.all ?? []).filter((provider) => catalog.connected?.includes(provider.id))
  const staticRoutes: Record<string, unknown> = {
    "/experimental/console": { consoleManagedProviders: [], activeOrgName: "Benchmark fixture", switchableOrgCount: 1 },
    "/api/command": { data: [] },
    "/api/mcp": { data: {} },
    "/api/mcp/resources": { data: {} },
    "/api/permission/request": { data: [] },
    "/api/question/request": { data: [] },
    "/provider": config.provider,
    "/api/provider": {
      data: available.map((provider) => ({
        id: provider.id,
        name: provider.name,
        api: { type: "native", settings: {} },
        request: { headers: {}, body: {} },
      })),
    },
    "/api/integration": {
      data: (catalog.all ?? []).map((provider) => ({
        id: provider.id,
        name: provider.name,
        methods: [{ type: "key" }],
        connections: [],
      })),
    },
    "/api/model": {
      data: available.flatMap((provider) =>
        Object.values(provider.models).map((model) => ({
          id: model.id,
          providerID: provider.id,
          name: model.name,
          family: model.family,
          api: { type: "native", id: model.id, settings: {} },
          capabilities: {
            tools: model.capabilities?.toolcall ?? false,
            input: Object.entries(model.capabilities?.input ?? { text: true })
              .filter(([, enabled]) => enabled)
              .map(([type]) => type),
            output: Object.entries(model.capabilities?.output ?? { text: true })
              .filter(([, enabled]) => enabled)
              .map(([type]) => type),
          },
          request: { headers: model.headers ?? {}, body: model.options ?? {} },
          variants: Object.entries(model.variants ?? {}).map(([id, body]) => ({ id, body, headers: {} })),
          time: { released: Date.parse(model.release_date) || 0 },
          cost: model.cost ? [model.cost] : [],
          status: model.status ?? "active",
          enabled: true,
          limit: model.limit ?? { context: 0, output: 0 },
        })),
      ),
    },
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/Zaovra",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/api/agent": {
      data: [{ id: "build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } }],
    },
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions,
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    const appPort = new URL(
      process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    ).port
    if (url.port !== targetPort && url.port !== appPort) return route.fallback()

    const path = url.pathname
    if (path === "/global/event" || path === "/event") return sse(route, config.events?.(), config.eventRetry)
    if (path === "/global/health") return json(route, { healthy: true })
    if (path === "/api/session/active") return json(route, { data: config.sessionStatus ?? {} })
    if (path === "/api/session")
      return json(route, {
        data: config.sessions.map((session) => v2Session(session, config.directory)),
        cursor: {},
      })
    if (path === "/experimental/capabilities") return json(route, { backgroundSubagents: false })
    if (path === "/permission")
      return json(route, typeof config.permissions === "function" ? config.permissions() : (config.permissions ?? []))
    if (path === "/question")
      return json(route, typeof config.questions === "function" ? config.questions() : (config.questions ?? []))
    if (path === "/session/status") return json(route, config.sessionStatus ?? {})
    if (path === "/vcs/diff" && config.vcsDiff) return json(route, config.vcsDiff)
    if (path === "/file" && config.fileList)
      return json(route, await config.fileList(url.searchParams.get("path") ?? ""))
    if (path === "/file/content" && config.fileContent)
      return json(route, await config.fileContent(url.searchParams.get("path") ?? ""))
    if (path === "/find/file" && config.findFiles)
      return json(
        route,
        await config.findFiles({
          query: url.searchParams.get("query") ?? "",
          dirs: url.searchParams.get("dirs") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }),
      )
    if (path === "/api/reference")
      return json(route, {
        location: {
          directory: config.directory,
          project: { id: (config.project as { id?: string }).id, directory: config.directory },
        },
        data: [],
      })
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const v2 = path.startsWith("/api/session/")
    const sessionPath = v2 ? path.slice(4) : path
    const sessionMatch = sessionPath.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, v2 && session ? { data: v2Session(session, config.directory) } : (session ?? {}))
    }

    const projectMatch = path.match(/^\/project\/([^/]+)$/)
    if (projectMatch) return json(route, config.project)

    const messageMatch = sessionPath.match(/^\/session\/([^/]+)\/message\/([^/]+)$/)
    if (messageMatch) {
      config.onMessage?.({ sessionID: messageMatch[1]!, messageID: messageMatch[2]! })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const message = config.message?.(messageMatch[1]!, messageMatch[2]!)
      if (message === undefined) return json(route, { error: "Message not found" }, undefined, 404)
      return json(route, v2 ? { data: v2Message(message) } : message)
    }

    const todoMatch = sessionPath.match(/^\/session\/([^/]+)\/todo$/)
    if (todoMatch) {
      const todos = config.todos?.(todoMatch[1]!) ?? []
      return json(route, v2 ? { data: todos } : todos)
    }
    if (v2 && /^\/session\/[^/]+\/(input\/pending|permission|question)$/.test(sessionPath))
      return json(route, { data: [] })
    if (v2 && /^\/session\/[^/]+\/message\/[^/]+\/diff$/.test(sessionPath)) return json(route, { data: [] })
    if (v2 && /^\/session\/[^/]+\/wait$/.test(sessionPath)) return json(route, {})
    if (/^\/session\/[^/]+\/(children|diff)$/.test(path)) return json(route, [])

    const messagesMatch = sessionPath.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const token = url.searchParams.get(v2 ? "cursor" : "before") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "start" })
      await config.beforeMessagesResponse?.({ sessionID: messagesMatch[1]!, before })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      config.onMessages?.({ sessionID: messagesMatch[1], before, phase: "end" })
      if (!pageData.cursor)
        return json(route, v2 ? { data: pageData.items.map(v2Message), cursor: {} } : pageData.items)
      const cursor = `cursor_${++nextCursor}`
      cursors.set(cursor, pageData.cursor)
      if (v2) return json(route, { data: pageData.items.map(v2Message), cursor: { next: cursor } })
      return json(route, pageData.items, { "x-next-cursor": cursor })
    }

    if (path.startsWith("/api/")) throw new Error(`Unhandled mock API route: ${path}`)
    if (url.port === targetPort && targetPort !== appPort) return json(route, {})
    return route.fallback()
  })
}

function v2Session(session: { id: string } & Record<string, unknown>, fallbackDirectory: string) {
  const time = session.time && typeof session.time === "object" ? session.time : {}
  return {
    id: session.id,
    parentID: session.parentID,
    agent: session.agent ?? "build",
    model: session.model,
    revert: session.revert,
    projectID: session.projectID ?? "project",
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: "created" in time && typeof time.created === "number" ? time.created : 0,
      updated: "updated" in time && typeof time.updated === "number" ? time.updated : 0,
      ...(session.time && typeof session.time === "object" && "archived" in session.time
        ? { archived: session.time.archived }
        : {}),
    },
    title: session.title ?? session.id,
    location: {
      directory: typeof session.directory === "string" ? session.directory : fallbackDirectory,
      ...(typeof session.workspaceID === "string" ? { workspaceID: session.workspaceID } : {}),
    },
    ...(typeof session.path === "string" ? { subpath: session.path } : {}),
  }
}

// Existing scenarios describe the desktop's legacy presentation shape. Serve
// the V2 wire shape so production builds exercise the real session adapter.
function v2Message(value: unknown): SessionMessage {
  const item = value as { info: Message; parts: Part[] }
  if (item.info.role === "user")
    return {
      id: item.info.id,
      type: "user",
      time: item.info.time,
      text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n"),
      files: item.parts.flatMap((part) =>
        part.type === "file" ? [{ uri: part.url, mime: part.mime, name: part.filename }] : [],
      ),
      agents: item.parts.flatMap((part) => (part.type === "agent" ? [{ name: part.name }] : [])),
    }
  return {
    id: item.info.id,
    type: "assistant",
    time: item.info.time,
    agent: item.info.agent,
    model: { id: item.info.modelID, providerID: item.info.providerID, variant: item.info.variant },
    cost: item.info.cost,
    tokens: item.info.tokens,
    finish: item.info.finish,
    content: item.parts.flatMap((part): Extract<SessionMessage, { type: "assistant" }>["content"] => {
      if (part.type === "text" || part.type === "reasoning") return [{ id: part.id, type: part.type, text: part.text }]
      if (part.type !== "tool") return []
      const state = part.state
      const structured: Record<string, unknown> = state.status === "pending" ? {} : { ...state.metadata }
      if (part.tool === "task" && typeof structured.sessionId === "string") {
        structured.task_id = structured.sessionId
        delete structured.sessionId
      }
      return [
        {
          type: "tool",
          id: part.id,
          name: part.tool,
          time: {
            created: state.status === "pending" ? item.info.time.created : state.time.start,
            completed: state.status === "completed" || state.status === "error" ? state.time.end : undefined,
          },
          state:
            state.status === "pending"
              ? { status: "pending", input: state.raw }
              : state.status === "error"
                ? {
                    status: "error",
                    input: state.input,
                    structured,
                    content: [],
                    error: { type: "unknown", message: state.error },
                  }
                : {
                    status: state.status,
                    input: state.input,
                    structured,
                    content: state.status === "completed" ? [{ type: "text", text: state.output }] : [],
                  },
        },
      ]
    }),
  }
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[], retry?: number) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `${retry === undefined ? "" : `retry: ${retry}\n\n`}${events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n"}`,
  })
}
