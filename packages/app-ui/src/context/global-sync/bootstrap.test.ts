import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Config, ZaovraClient, Project, Session } from "@zaovra-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@zaovra-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadPathQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"
import { loadLspQuery, loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const emptyCatalog = {
  provider: { list: async () => ({ data: { data: [] } }) },
  model: { list: async () => ({ data: { data: [] } }) },
  integration: { list: async () => ({ data: { data: [] } }) },
}

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        config: { get: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        v2: {
          ...emptyCatalog,
          agent: {
            list: async () => ({
              data: {
                data: [
                  { id: "build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } },
                ],
              },
            }),
          },
          command: {
            list: async () => {
              mcpReads.push("command")
              return { data: { data: [] } }
            },
          },
          permission: { request: { list: async () => ({ data: { data: [] } }) } },
          question: { request: { list: async () => ({ data: { data: [] } }) } },
          reference: { list: async () => ({ data: { data: [] } }) },
          session: { active: async () => ({ data: { data: {} } }) },
        },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as ZaovraClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("seeds session status even while warming session info stalls", async () => {
    const [store, setStore] = directoryState()
    const stalled = Promise.withResolvers<never>()
    const client = {
      config: { get: async () => ({ data: {} }) },
      vcs: { get: async () => ({ data: undefined }) },
      v2: {
        ...emptyCatalog,
        agent: {
          list: async () => ({
            data: {
              data: [
                { id: "build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } },
              ],
            },
          }),
        },
        command: { list: async () => ({ data: { data: [] } }) },
        permission: { request: { list: async () => ({ data: { data: [] } }) } },
        question: { request: { list: async () => ({ data: { data: [] } }) } },
        reference: { list: async () => ({ data: { data: [] } }) },
        session: {
          active: async () => ({ data: { data: { ses_busy: { type: "running" } } } }),
          get: () => stalled.promise,
        },
      },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ZaovraClient
    const session = createServerSession(client)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()
  })

  test("refreshes cached agents and bootstraps commands from the V2 location control plane", async () => {
    const [store, setStore] = directoryState()
    const calls: string[] = []
    const client = {
      config: { get: async () => ({ data: {} }) },
      vcs: { get: async () => ({ data: undefined }) },
      v2: {
        ...emptyCatalog,
        agent: {
          list: async () => ({
            data: {
              data: [
                { id: "build", mode: "primary", hidden: false, permissions: [], request: { headers: {}, body: {} } },
              ],
            },
          }),
        },
        command: {
          list: async () => {
            calls.push("v2.command.list")
            return {
              data: {
                data: [
                  {
                    name: "review",
                    template: "Review the current changes",
                    model: { providerID: "openai", id: "gpt-5" },
                  },
                ],
              },
            }
          },
        },
        permission: { request: { list: async () => ({ data: { data: [] } }) } },
        question: { request: { list: async () => ({ data: { data: [] } }) } },
        reference: { list: async () => ({ data: { data: [] } }) },
        session: { active: async () => ({ data: { data: {} } }) },
        mcp: {
          status: async () => ({ data: { data: {} } }),
          resources: async () => ({ data: { data: {} } }),
        },
      },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as ZaovraClient

    const queries = new QueryClient()
    queries.setQueryData(loadAgentsQuery(ServerScope.local, "/project", client).queryKey, [
      { name: "removed-agent", mode: "primary", hidden: false, options: {}, permission: [] },
    ])

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: queries,
    })

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(calls).toEqual(["v2.command.list"])
    expect(store.agent.map((agent) => agent.name)).toEqual(["build"])
    expect(store.command).toEqual([
      {
        name: "review",
        template: "Review the current changes",
        model: "openai/gpt-5",
        source: "command",
        hints: [],
      },
    ])
  })
})

describe("query keys", () => {
  test("configuration refresh updates the provider cache observed by Windows directory stores", async () => {
    let connected = ["custom"]
    const client = {
      v2: {
        ...emptyCatalog,
        provider: {
          list: async () => ({
            data: {
              data: connected.map((id) => ({ id, name: id })),
            },
          }),
        },
      },
    } as unknown as ZaovraClient
    const queries = new QueryClient()
    const observed = loadProvidersQuery(ServerScope.local, "C:/project", client)
    await queries.fetchQuery(observed)
    connected = []
    await queries.fetchQuery(loadProvidersQuery(ServerScope.local, "C:\\project\\", client))
    expect(queries.getQueryData(observed.queryKey)?.connected).toEqual([])
    expect(queries.getQueryCache().getAll()).toHaveLength(1)
    queries.clear()
  })

  test("normalizes directory keys consistently across bootstrap queries", () => {
    const client = {} as ZaovraClient
    for (const load of [
      loadProvidersQuery,
      loadAgentsQuery,
      loadPathQuery,
      loadReferencesQuery,
      loadMcpQuery,
      loadMcpResourcesQuery,
      loadLspQuery,
    ]) {
      expect(load(ServerScope.local, "C:\\project\\", client).queryKey).toEqual(
        load(ServerScope.local, "C:/project", client).queryKey,
      )
    }
  })

  test("partitions identical directories by server scope", () => {
    const client = {} as ZaovraClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
