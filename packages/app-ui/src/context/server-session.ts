import { Binary } from "@zaovra-ai/core/util/binary"
import { retry } from "@zaovra-ai/core/util/retry"
import type {
  Event,
  Message,
  ZaovraClient,
  Part,
  PermissionView,
  QuestionView,
  Session,
  SessionInputAdmitted,
  SessionMessage,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
} from "@zaovra-ai/sdk/v2/client"
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { diffs as cleanDiffs, message as cleanMessage } from "@/utils/diffs"
import { sessionNotFoundError } from "@/utils/server-errors"
import { rootSession } from "@/utils/session-route"
import { dropSessionCaches, pickSessionCacheEvictions, SESSION_CACHE_LIMIT } from "./global-sync/session-cache"
import {
  adaptPartID,
  adaptSession,
  adaptSessionInput,
  adaptSessionMessages,
  type AdaptCache,
  type SessionView,
} from "./v2-session-adapter"
import { createSessionFeed, type FeedEvent, type SessionFeed } from "./session-feed"
import { adaptPermissionRequest } from "./global-sync/utils"
import { adaptServerEvent } from "./server-event"

function appendOffsetText(text: string, chunks: ReadonlyMap<number, string>) {
  return [...chunks]
    .sort(([left], [right]) => left - right)
    .reduce(
      (text, [offset, delta]) => (offset <= text.length ? text + delta.slice(Math.max(0, text.length - offset)) : text),
      text,
    )
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const cmpMessage = (a: Message, b: Message) => a.time.created - b.time.created || cmp(a.id, b.id)
const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const initialMessagePageSize = 20
const historyMessagePageSize = 200
const sessionInfoLimit = 2_048
const emptyIDs: ReadonlySet<string> = new Set()

type OptimisticItem = {
  message: Message
  parts: Part[]
  confirmedParts?: Part[]
  confirmedMessage?: boolean
}

type Adapted = { message: Message; parts: Part[] }

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
  unresolved?: SessionMessage[]
}

// Most markers describe the current HTTP attempt; deltaParts persists non-durable stream state across retries.
type MessageLoadState = {
  touchedMessages: Set<string>
  removedMessages: Set<string>
  retainedMessages: Set<string>
  touchedParts: Map<string, Set<string>>
  deltaParts: Map<string, Set<string>>
  carriedDeltaParts: Map<string, Set<string>>
  removedParts: Map<string, Set<string>>
  optimisticParts: Map<string, Set<string>>
  orphanParents: Set<string>
  clearedMessageParts: Set<string>
}

function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, observed: [] as { messageID: string; parts: Part[] }[] }
  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, item.part]))
  const observed: { messageID: string; parts: Part[] }[] = []
  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    if (!result.found) session.splice(result.index, 0, item.message)
    const current = part.get(item.message.id)
    const confirmed = result.found ? item.parts.filter((part) => current?.some((value) => value.id === part.id)) : []
    if (result.found) observed.push({ messageID: item.message.id, parts: confirmed })
    part.set(
      item.message.id,
      merge(
        result.found ? (current ?? []) : merge(item.confirmedParts ?? [], current ?? []),
        item.parts.filter((part) => !confirmed.includes(part)),
      ),
    )
  }
  return {
    ...page,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, parts]) => ({ id, part: parts })),
    observed,
  }
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  return promise
}

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const items = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) items.set(item.id, item)
  return [...items.values()]
}

function reconcileFetched<T extends { id: string }>(
  fetched: T[],
  current: readonly T[],
  options: {
    touched?: ReadonlySet<string>
    retained?: ReadonlySet<string>
    preserveUnfetched?: boolean | ((item: T) => boolean)
    sourceOrder?: boolean
  } = {},
) {
  const result = new Map(fetched.map((item) => [item.id, item]))
  const live = new Map(current.map((item) => [item.id, item]))
  if (options.preserveUnfetched) {
    for (const item of current) {
      if (!result.has(item.id) && (options.preserveUnfetched === true || options.preserveUnfetched(item)))
        result.set(item.id, item)
    }
  }
  for (const id of options.retained ?? emptyIDs) {
    if (result.has(id)) continue
    const item = live.get(id)
    if (item) result.set(id, item)
  }
  // Events observed while the request is pending are the freshest client state for those identities.
  for (const id of options.touched ?? emptyIDs) {
    const item = live.get(id)
    if (item) result.set(id, item)
    if (!item) result.delete(id)
  }
  const items = [...result.values()]
  return options.sourceOrder ? items : items.sort((a, b) => cmp(a.id, b.id))
}

export function createServerSession(client: ZaovraClient, options?: { retry?: typeof retry }) {
  // Confirmed local Stop receipts are presentation state, never synthetic model history.
  const [stoppedTurns, setStoppedTurns] = createStore<Record<string, string>>({})
  const [data, setData] = createStore({
    info: {} as Record<string, SessionView | undefined>,
    session_status: {} as Record<string, SessionStatus>,
    session_diff: {} as Record<string, SnapshotFileDiff[]>,
    todo: {} as Record<string, Todo[]>,
    permission: {} as Record<string, PermissionView[]>,
    question: {} as Record<string, QuestionView[]>,
    pending_input: {} as Record<string, SessionInputAdmitted[]>,
    live_shell: {} as Record<string, Record<string, true>>,
    // Live-only: the text part receiving deltas. Snapshots cannot tell finished text from streaming text.
    streaming_text: {} as Record<string, string | undefined>,
    message: {} as Record<string, Message[]>,
    part: {} as Record<string, Part[]>,
    part_text_accum_delta: {} as Record<string, string>,
    session_working(id: string) {
      return (this.session_status[id]?.type ?? "idle") !== "idle"
    },
  })
  const requests = new Map<string, Promise<SessionView>>()
  const v2Info = new Map<string, Parameters<typeof adaptSession>[0]>()
  const unresolvedHistory = new Map<string, { cursor: string; messages: SessionMessage[] }>()
  const inflight = new Map<string, Promise<void>>()
  const inflightDiff = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const messageLoads = new Map<string, MessageLoadState>()
  const pendingParts = new Map<string, Map<string, Set<string>>>()
  const orphanParts = new Map<string, Set<string>>()
  const removedMessages = new Map<string, Set<string>>()
  const v2Refreshes = new Map<string, ReturnType<typeof setTimeout>>()
  const resyncs = new Map<string, Promise<void>>()
  const questionLoads = new Map<string, Promise<void>>()
  const questionVersions = new Map<string, number>()
  const admitted = new Map<string, Map<string, false | "steer" | "queue">>()
  let silentAt = 0
  // The server sequences durable Session events and stamps message pages (specs/v2/desktop-sync.md).
  // Until it says so, the page re-reading path below is the only way to stay current.
  let capable = false
  const eventAt = new Map<string, number>()
  const eventVersion = new Map<string, object>()
  // Bumped per text delta so a snapshot requested before a delta cannot end the stream that delta proves is alive.
  const textDeltas = new Map<string, number>()
  const executionWaits = new Map<string, Promise<void>>()
  const deltaBases = new Map<string, { base: string; sessionID: string }>()
  const offsetChunks = new Map<string, { sessionID: string; chunks: Map<number, string> }>()
  const deleteMessageParts = (
    cache: { part: Record<string, Part[] | undefined>; part_text_accum_delta: Record<string, string | undefined> },
    messageID: string,
  ) => {
    for (const part of cache.part[messageID] ?? []) {
      delete cache.part_text_accum_delta[part.id]
      deltaBases.delete(part.id)
      offsetChunks.delete(part.id)
    }
    delete cache.part[messageID]
  }
  const seen = new Set<string>()
  const infoSeen = new Set<string>()
  const pinned = new Map<string, number>()
  const generations = new Map<string, object>()
  const generation = (sessionID: string) => {
    const current = generations.get(sessionID)
    if (current) return current
    const created = {}
    generations.set(sessionID, created)
    return created
  }
  const watchExecution = (sessionID: string) =>
    runInflight(executionWaits, sessionID, async () => {
      const active = generation(sessionID)
      // Status changes arrive as events. This only resolves when the work is over, for callers that wait on it.
      while (capable && generations.get(sessionID) === active) {
        const failure = await client.v2.session.wait({ sessionID }, { throwOnError: true }).then(
          () => undefined,
          (error: unknown) => error,
        )
        await refreshActive()
        if (!data.session_working(sessionID)) return
        if (failure) throw failure
        // Still working: a new drain took over. Never spin if the answers stop making sense.
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (capable) return
      // A provider step may finish while tools, another turn, or queued inputs
      // still belong to the same drain. Only process ownership establishes idle.
      while (generations.get(sessionID) === active) {
        const failure = await client.v2.session.wait({ sessionID }, { throwOnError: true }).then(
          () => undefined,
          (error: unknown) => error,
        )
        const result = await client.v2.session.active({ throwOnError: true })
        if (generations.get(sessionID) !== active) return
        if (!result.data.data[sessionID]) {
          const version = eventVersion.get(sessionID)
          // A final SSE event may be missed while a new task mounts or reconnects.
          // Reconcile persisted history after any older in-flight snapshot settles.
          await inflight.get(sessionID)?.catch(() => {})
          if (generations.get(sessionID) !== active) return
          await sync(sessionID, { force: true })
          if (generations.get(sessionID) !== active) return
          // A new provider event wins over this older ownership check.
          if (eventVersion.get(sessionID) !== version && data.session_working(sessionID)) continue
          // Admission and process ownership are separate. A wake may not have acquired
          // the coordinator yet; keep waiting presentation without spinning wait/active.
          if ([...(admitted.get(sessionID)?.values() ?? [])].some(Boolean)) return
          setData("session_status", sessionID, { type: "idle" })
          setData("streaming_text", sessionID, undefined)
          return
        }
        if (failure) throw failure
      }
    })
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number | undefined>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    at: {} as Record<string, number | undefined>,
  })

  const remember = (session: SessionView) => {
    setData("info", session.id, reconcile(session))
    infoSeen.delete(session.id)
    infoSeen.add(session.id)
    if (infoSeen.size > sessionInfoLimit) {
      const preserve = new Set([
        ...pinned.keys(),
        ...requests.keys(),
        ...inflight.keys(),
        ...inflightDiff.keys(),
        ...inflightTodo.keys(),
        ...messageLoads.keys(),
        ...optimistic.keys(),
        ...Object.entries(data.permission)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.question)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.session_status)
          .filter(([, status]) => status.type !== "idle")
          .map(([sessionID]) => sessionID),
      ])
      for (const sessionID of preserve) {
        let current = data.info[sessionID]
        while (current) {
          preserve.add(current.id)
          current = current.parentID ? data.info[current.parentID] : undefined
        }
      }
      const stale: string[] = []
      for (const sessionID of infoSeen) {
        if (infoSeen.size - stale.length <= sessionInfoLimit) break
        if (!preserve.has(sessionID)) stale.push(sessionID)
      }
      stale.forEach((sessionID) => infoSeen.delete(sessionID))
      stale.forEach((sessionID) => generations.delete(sessionID))
      setData(
        "info",
        produce((draft) => stale.forEach((sessionID) => delete draft[sessionID])),
      )
    }
    return session
  }

  const resolve = (sessionID: string, options?: { force?: boolean }): Promise<SessionView> => {
    const cached = data.info[sessionID]
    if (cached && !options?.force) return Promise.resolve(cached)
    const pending = requests.get(sessionID)
    if (pending)
      return options?.force ? pending.catch(() => undefined).then(() => resolve(sessionID, options)) : pending
    const active = generation(sessionID)
    const request = client.v2.session
      .get({ sessionID }, { signal: AbortSignal.timeout(10_000), throwOnError: true })
      .then((result) => {
        if (!result.data?.data) throw sessionNotFoundError(sessionID)
        v2Info.set(sessionID, result.data.data)
        const session = adaptSession(result.data.data)
        if (generations.get(sessionID) !== active) return session
        const remembered = remember(session)
        // User messages show the session's agent and model when they carry none of their own.
        if (capable) flush(sessionID)
        return remembered
      })
    requests.set(sessionID, request)
    const cleanup = () => {
      if (requests.get(sessionID) === request) requests.delete(sessionID)
      if (
        generations.get(sessionID) === active &&
        !data.info[sessionID] &&
        !requests.has(sessionID) &&
        !messageLoads.has(sessionID) &&
        !inflight.has(sessionID) &&
        !inflightDiff.has(sessionID) &&
        !inflightTodo.has(sessionID)
      )
        generations.delete(sessionID)
    }
    void request.then(cleanup, cleanup)
    return request
  }

  const peekLineage = (sessionID: string) => {
    const session = data.info[sessionID]
    if (!session) return
    const seen = new Set([session.id])
    let root = session
    while (root.parentID) {
      if (seen.has(root.parentID)) throw new Error(`Session parent cycle: ${root.parentID}`)
      seen.add(root.parentID)
      const parent = data.info[root.parentID]
      if (!parent) return
      root = parent
    }
    return { session, root }
  }

  const clearOptimistic = (sessionID: string, messageID?: string) => {
    if (!messageID) {
      optimistic.delete(sessionID)
      return
    }
    const items = optimistic.get(sessionID)
    if (!items) return
    items.delete(messageID)
    if (items.size === 0) optimistic.delete(sessionID)
  }

  const clearOptimisticPart = (sessionID: string, messageID: string, partID: string) => {
    const items = optimistic.get(sessionID)
    const item = items?.get(messageID)
    if (!items || !item) return
    const parts = item.parts.filter((part) => part.id !== partID)
    const confirmedParts = item.confirmedParts?.filter((part) => part.id !== partID)
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    items.set(messageID, { ...item, parts, confirmedParts, confirmedMessage: true })
  }

  const confirmOptimisticPart = (sessionID: string, messageID: string, part: Part) => {
    const items = optimistic.get(sessionID)
    const item = items?.get(messageID)
    if (!items || !item) return
    const parts = item.parts.filter((value) => value.id !== part.id)
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    items.set(messageID, {
      ...item,
      parts,
      confirmedParts: merge(item.confirmedParts ?? [], [part]),
      confirmedMessage: true,
    })
  }

  const confirmOptimistic = (sessionID: string, messageID: string, confirmedParts: Part[]) => {
    const items = optimistic.get(sessionID)
    const item = items?.get(messageID)
    if (!items || !item) return
    const confirmed = new Set(confirmedParts.map((part) => part.id))
    const parts = item.parts.filter((part) => !confirmed.has(part.id))
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    items.set(messageID, {
      ...item,
      parts,
      confirmedParts: merge(item.confirmedParts ?? [], confirmedParts),
      confirmedMessage: true,
    })
  }

  const trackPartChange = (sessionID: string, messageID: string, partID: string) => {
    const load = messageLoads.get(sessionID)
    if (!load) return
    // A part event keeps an existing parent when the fetched page omits it without overriding fetched metadata.
    const messages = data.message[sessionID]
    if (messages && Binary.search(messages, messageID, (message) => message.id).found)
      load.retainedMessages.add(messageID)
    const parts = load.touchedParts.get(messageID)
    if (parts) {
      parts.add(partID)
      return
    }
    load.touchedParts.set(messageID, new Set([partID]))
  }

  const resetMessageLoad = (sessionID: string, load: MessageLoadState) => {
    load.touchedMessages.clear()
    load.retainedMessages.clear()
    load.touchedParts.clear()
    load.carriedDeltaParts.clear()
    load.clearedMessageParts.clear()
    for (const messageID of load.removedMessages) {
      load.touchedMessages.add(messageID)
      load.clearedMessageParts.add(messageID)
    }
    for (const [messageID, parts] of load.deltaParts) {
      load.touchedParts.set(messageID, new Set(parts))
      load.carriedDeltaParts.set(messageID, new Set(parts))
      const messages = data.message[sessionID]
      if (messages && Binary.search(messages, messageID, (message) => message.id).found)
        load.retainedMessages.add(messageID)
    }
    for (const [messageID, parts] of load.removedParts) {
      const touched = load.touchedParts.get(messageID) ?? new Set<string>()
      parts.forEach((partID) => touched.add(partID))
      load.touchedParts.set(messageID, touched)
      const messages = data.message[sessionID]
      if (messages && Binary.search(messages, messageID, (message) => message.id).found)
        load.retainedMessages.add(messageID)
    }
    for (const [messageID, parts] of load.optimisticParts) {
      load.removedMessages.delete(messageID)
      load.clearedMessageParts.add(messageID)
      load.touchedMessages.add(messageID)
      const touched = load.touchedParts.get(messageID) ?? new Set<string>()
      parts.forEach((partID) => touched.add(partID))
      load.touchedParts.set(messageID, touched)
    }
  }

  const evict = (sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    const evicted = new Set(sessionIDs)
    for (const [partID, item] of deltaBases) {
      if (evicted.has(item.sessionID)) deltaBases.delete(partID)
    }
    for (const [partID, item] of offsetChunks) {
      if (evicted.has(item.sessionID)) offsetChunks.delete(partID)
    }
    sessionIDs.forEach((sessionID) => {
      setData("live_shell", sessionID, undefined!)
      generations.delete(sessionID)
      eventAt.delete(sessionID)
      eventVersion.delete(sessionID)
      textDeltas.delete(sessionID)
      resyncs.delete(sessionID)
      admitted.delete(sessionID)
      questionVersions.delete(sessionID)
      clearOptimistic(sessionID)
      requests.delete(sessionID)
      v2Info.delete(sessionID)
      unresolvedHistory.delete(sessionID)
      dropFeed(sessionID)
      inflight.delete(sessionID)
      inflightDiff.delete(sessionID)
      inflightTodo.delete(sessionID)
      messageLoads.delete(sessionID)
      pendingParts.delete(sessionID)
      orphanParts.delete(sessionID)
      removedMessages.delete(sessionID)
      const refresh = v2Refreshes.get(sessionID)
      if (refresh) clearTimeout(refresh)
      v2Refreshes.delete(sessionID)
    })
    setStoppedTurns(
      produce((turns) => {
        Object.entries(turns).forEach(([id, sessionID]) => {
          if (sessionIDs.includes(sessionID)) delete turns[id]
        })
      }),
    )
    setData(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
        sessionIDs.forEach((sessionID) => {
          delete draft.pending_input[sessionID]
          delete draft.streaming_text[sessionID]
        })
      }),
    )
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          delete draft.limit[sessionID]
          delete draft.cursor[sessionID]
          delete draft.complete[sessionID]
          delete draft.loading[sessionID]
          delete draft.at[sessionID]
        }
      }),
    )
  }

  const protectedSessions = () =>
    new Set([
      ...pinned.keys(),
      ...requests.keys(),
      ...inflight.keys(),
      ...inflightDiff.keys(),
      ...inflightTodo.keys(),
      ...messageLoads.keys(),
      ...optimistic.keys(),
      ...Object.entries(data.permission)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.question)
        .filter(([, items]) => items.length > 0)
        .map(([sessionID]) => sessionID),
      ...Object.entries(data.session_status)
        .filter(([, status]) => status.type !== "idle")
        .map(([sessionID]) => sessionID),
    ])

  const touch = (sessionID: string) =>
    evict(
      pickSessionCacheEvictions({ seen, keep: sessionID, limit: SESSION_CACHE_LIMIT, preserve: protectedSessions() }),
    )

  const fetchMessages = async (sessionID: string, limit: number, before?: string, onAttempt?: () => void) => {
    const session =
      v2Info.get(sessionID) ?? (await (options?.retry ?? retry)(() => client.v2.session.get({ sessionID }))).data?.data
    if (!session) throw sessionNotFoundError(sessionID)
    v2Info.set(sessionID, session)
    const active = generation(sessionID)
    const version = eventVersion.get(sessionID)
    const pending = (options?.retry ?? retry)(() => client.v2.session.pendingInputs({ sessionID })).then((response) => {
      if (!response.data) throw new Error(`Unable to load pending inputs: ${sessionID}`)
      if (generations.get(sessionID) === active) {
        const current = admitted.get(sessionID) ?? new Map<string, false | "steer" | "queue">()
        // A later promotion wins over an older pending-input snapshot.
        response.data.data.forEach((input) => {
          if (current.get(input.id) !== false) current.set(input.id, input.delivery)
        })
        admitted.set(sessionID, current)
        if (eventVersion.get(sessionID) === version) {
          const pendingIDs = new Set(response.data.data.map((input) => input.id))
          current.forEach((pending, id) => {
            if (pending && !pendingIDs.has(id) && !optimistic.get(sessionID)?.has(id)) current.delete(id)
          })
          setData("pending_input", sessionID, response.data.data)
        }
      }
      return response.data.data
    })

    const pages = [] as NonNullable<Awaited<ReturnType<typeof client.v2.session.messages>>["data"]>[]
    const loadPage = async (cursor?: string) => {
      const response = await (options?.retry ?? retry)(() => {
        onAttempt?.()
        return client.v2.session.messages({
          sessionID,
          limit: Math.min(100, Math.max(initialMessagePageSize, limit)),
          cursor,
          order: cursor ? undefined : "desc",
        })
      })
      if (!response.data) throw new Error(`Unable to load messages: ${sessionID}`)
      pages.push(response.data)
      return response.data
    }
    const first = await loadPage(before)
    const pendingInputs = await pending
    const oldest = first.data.reduce<SessionMessage | undefined>(
      (result, item) =>
        !result ||
        item.time.created < result.time.created ||
        (item.time.created === result.time.created && item.id < result.id)
          ? item
          : result,
      undefined,
    )
    // A cached user from a newer page cannot own output in an older page.
    const cachedParent =
      oldest &&
      (data.message[sessionID] ?? [])
        .filter(
          (message) =>
            message.role === "user" &&
            !data.part[message.id]?.some((part) => part.type === "text" && part.synthetic) &&
            !admitted.get(sessionID)?.get(message.id) &&
            (message.time.created < oldest.time.created ||
              (message.time.created === oldest.time.created && message.id <= oldest.id)),
        )
        .sort(cmpMessage)
        .at(-1)?.id
    let cursor = first.cursor.next
    for (let page = first; !cachedParent && !page.data.some((item) => item.type === "user") && cursor; ) {
      page = await loadPage(cursor)
      cursor = page.cursor.next
    }
    const carried = unresolvedHistory.get(sessionID)
    const items = [
      ...pages.flatMap((page) => page.data),
      ...(before && carried?.cursor === before ? carried.messages : []),
    ]
    items.forEach((item) => {
      if (item.type === "user") admitted.get(sessionID)?.set(item.id, false)
    })
    const adapted = [
      ...adaptSessionMessages(session, items, cachedParent),
      ...pendingInputs.map((input) => adaptSessionInput(session, input)),
    ].sort((a, b) => cmpMessage(a.message, b.message))
    const adaptedIDs = new Set(adapted.map((item) => item.message.id))
    return {
      session: adapted.map((item) => cleanMessage(item.message)).sort((a, b) => cmp(a.id, b.id)),
      part: adapted.map((item) => ({
        id: item.message.id,
        part: item.parts.filter((part) => !!part.id),
      })),
      cursor,
      complete: !cursor,
      // Keep the leading partial turn until pagination brings its user. The
      // server cursor already passed these messages, so dropping them loses output.
      unresolved: items.filter((item) => item.type === "assistant" && !adaptedIDs.has(item.id)),
    }
  }

  const replaceMessages = (sessionID: string, messages: Message[]) => {
    const messageIDs = new Set(messages.map((message) => message.id))
    const dropped = (data.message[sessionID] ?? []).filter((message) => !messageIDs.has(message.id))
    setData("message", sessionID, reconcile(messages, { key: "id" }))
    setData(
      produce((draft) => {
        for (const message of dropped) deleteMessageParts(draft, message.id)
      }),
    )
    return messageIDs
  }

  const replaceParts = (
    sessionID: string,
    items: MessagePage["part"],
    messageIDs: Set<string>,
    load?: MessageLoadState,
  ) => {
    for (const item of items) {
      if (!messageIDs.has(item.id)) continue
      const fetched = load?.clearedMessageParts.has(item.id)
        ? []
        : item.part.filter((part) => !SKIP_PARTS.has(part.type))
      const fetchedIDs = new Set(fetched.map((part) => part.id))
      const pending = pendingParts.get(sessionID)?.get(item.id)
      const touched = new Set([...(load?.touchedParts.get(item.id) ?? []), ...(pending ?? [])])
      for (const part of fetched) {
        const buffered = offsetChunks.get(part.id)
        if (buffered && (part.type === "text" || part.type === "reasoning")) {
          part.text = appendOffsetText(part.text, buffered.chunks)
          for (const [offset, delta] of buffered.chunks) {
            if (offset + delta.length <= part.text.length) buffered.chunks.delete(offset)
          }
          if (!buffered.chunks.size) offsetChunks.delete(part.id)
          touched.delete(part.id)
        }
        const accumulated = data.part_text_accum_delta[part.id]
        const base = deltaBases.get(part.id)?.base
        const preserveDelta =
          base !== undefined &&
          accumulated !== undefined &&
          "text" in part &&
          typeof part.text === "string" &&
          part.text.startsWith(base) &&
          accumulated.startsWith(part.text) &&
          accumulated !== part.text
        if (preserveDelta) touched.add(part.id)
        if (load?.carriedDeltaParts.get(item.id)?.has(part.id) && !preserveDelta) touched.delete(part.id)
      }
      for (const partID of load?.carriedDeltaParts.get(item.id) ?? []) {
        if (!fetchedIDs.has(partID)) touched.delete(partID)
      }
      const parts = reconcileFetched(fetched, data.part[item.id] ?? [], { touched, sourceOrder: true })
      if (!parts.length) {
        orphanParts.get(sessionID)?.delete(item.id)
        setData(produce((draft) => deleteMessageParts(draft, item.id)))
        continue
      }
      const partIDs = new Set(parts.map((part) => part.id))
      setData(
        "part_text_accum_delta",
        produce((draft) => {
          for (const part of data.part[item.id] ?? []) {
            if (!partIDs.has(part.id) || !touched.has(part.id)) {
              delete draft[part.id]
              deltaBases.delete(part.id)
            }
          }
        }),
      )
      setData("part", item.id, reconcile(parts, { key: "id" }))
      orphanParts.get(sessionID)?.delete(item.id)
    }
  }

  const applyMessagePage = (
    sessionID: string,
    page: MessagePage,
    load: MessageLoadState | undefined,
    preserveUnfetched: boolean | ((message: Message) => boolean),
    cleanupOrphans: boolean,
  ) => {
    if (page.cursor && page.unresolved?.length)
      unresolvedHistory.set(sessionID, { cursor: page.cursor, messages: page.unresolved })
    if (!page.cursor || !page.unresolved?.length) unresolvedHistory.delete(sessionID)
    const merged = mergeOptimisticPage(page, [...(optimistic.get(sessionID)?.values() ?? [])])
    merged.observed.forEach((item) => {
      if (!load?.clearedMessageParts.has(item.messageID)) confirmOptimistic(sessionID, item.messageID, item.parts)
    })
    const touchedMessages = new Set([...(load?.touchedMessages ?? []), ...(removedMessages.get(sessionID) ?? [])])
    const messages = reconcileFetched(merged.session, data.message[sessionID] ?? [], {
      touched: touchedMessages,
      retained: load?.retainedMessages,
      preserveUnfetched,
    })
    batch(() => {
      const messageIDs = replaceMessages(sessionID, messages)
      replaceParts(sessionID, merged.part, messageIDs, load)
      const orphans = orphanParts.get(sessionID)
      if (cleanupOrphans && page.complete && orphans) {
        for (const messageID of orphans) {
          if (!messageIDs.has(messageID)) setData(produce((draft) => deleteMessageParts(draft, messageID)))
        }
        orphanParts.delete(sessionID)
      }
      setMeta("limit", sessionID, messages.length)
      setMeta("cursor", sessionID, merged.cursor)
      setMeta("complete", sessionID, merged.complete)
      setMeta("at", sessionID, Date.now())
    })
  }

  const loadMessages = async (sessionID: string, limit: number, before?: string, mode?: "replace" | "prepend") => {
    if (meta.loading[sessionID]) return
    const active = generation(sessionID)
    const load: MessageLoadState = {
      touchedMessages: new Set(),
      removedMessages: new Set(),
      retainedMessages: new Set(),
      touchedParts: new Map(),
      deltaParts: new Map(),
      carriedDeltaParts: new Map(),
      removedParts: new Map(),
      optimisticParts: new Map(),
      orphanParents: new Set(),
      clearedMessageParts: new Set(),
    }
    messageLoads.set(sessionID, load)
    setMeta("loading", sessionID, true)
    const deltas = textDeltas.get(sessionID)
    let applied = false
    try {
      const page = await fetchMessages(sessionID, limit, before, () => resetMessageLoad(sessionID, load))
      const first = page.session.reduce<Message | undefined>(
        (oldest, message) => (!oldest || cmpMessage(message, oldest) < 0 ? message : oldest),
        undefined,
      )
      // The ordered feed took over while this request was in flight; its state is the newer one.
      if (generations.get(sessionID) !== active || capable) return
      const preserveUnfetched =
        mode === "prepend" || (!page.complete && (!first || ((message: Message) => cmpMessage(message, first) < 0)))
      applyMessagePage(
        sessionID,
        page,
        messageLoads.get(sessionID) === load ? load : undefined,
        preserveUnfetched,
        mode !== "prepend",
      )
      // The end event can be lost without a reconnect, so a completed owner is the remaining proof the text ended.
      if (textDeltas.get(sessionID) === deltas) {
        const marker = data.streaming_text[sessionID]
        const owner = data.message[sessionID]?.find((message) =>
          data.part[message.id]?.some((part) => part.id === marker),
        )
        if (owner?.role === "assistant" && (owner.time.completed !== undefined || owner.error))
          setData("streaming_text", sessionID, undefined)
      }
      applied = true
    } finally {
      if (!applied && generations.get(sessionID) === active && messageLoads.get(sessionID) === load) {
        for (const messageID of load.orphanParents) {
          if (!orphanParts.get(sessionID)?.has(messageID)) continue
          setData(produce((draft) => deleteMessageParts(draft, messageID)))
          orphanParts.get(sessionID)?.delete(messageID)
        }
        if (orphanParts.get(sessionID)?.size === 0) orphanParts.delete(sessionID)
      }
      if (messageLoads.get(sessionID) === load) messageLoads.delete(sessionID)
      if (generations.get(sessionID) === active) setMeta("loading", sessionID, false)
    }
  }

  const sync = (sessionID: string, options?: { force?: boolean; messageLimit?: number }) => {
    touch(sessionID)
    return runInflight(inflight, sessionID, async () => {
      if (capable) {
        // `force` asks for current state. A feed that is already following only needs what it missed.
        const following = feeds.get(sessionID)?.ready === true
        if (following && data.info[sessionID] && !options?.force) return
        await Promise.all([
          resolve(sessionID, options),
          following
            ? options?.force
              ? catchUp(sessionID)
              : undefined
            : readSnapshot(sessionID, options?.messageLimit ?? meta.limit[sessionID] ?? initialMessagePageSize),
        ])
        return
      }
      const cached = data.message[sessionID] !== undefined && meta.limit[sessionID] !== undefined
      if (cached && data.info[sessionID] && !options?.force) return
      await Promise.all([
        resolve(sessionID, options),
        cached && !options?.force
          ? Promise.resolve()
          : loadMessages(sessionID, options?.messageLimit ?? meta.limit[sessionID] ?? initialMessagePageSize),
      ])
    })
  }

  const prefetch = async (sessionID: string, limit: number) => {
    touch(sessionID)
    await inflight.get(sessionID)
    if (capable) {
      if (feeds.get(sessionID)?.ready) return
      await runInflight(inflight, sessionID, () => readSnapshot(sessionID, limit))
      return
    }
    if (
      Date.now() - (meta.at[sessionID] ?? 0) <= 15_000 &&
      (meta.complete[sessionID] || (data.message[sessionID]?.length ?? 0) >= limit)
    )
      return
    await runInflight(inflight, sessionID, () => loadMessages(sessionID, limit))
  }

  // ---------------------------------------------------------------------------------------------
  // Ordered feed (specs/v2/desktop-sync.md). Active once the server announces `sync` on connect.
  // A session is read as one snapshot, then kept current by applying durable events in sequence.
  // Nothing below re-reads a message page because an event arrived.
  // ---------------------------------------------------------------------------------------------
  const feeds = new Map<string, SessionFeed>()
  const adaptCaches = new Map<string, AdaptCache>()
  const inputCache = new WeakMap<SessionInputAdmitted, { key: string; value: Adapted }>()
  const written = new Map<string, Map<string, Adapted>>()
  const executions = new Map<string, { epoch: number; revision: number }>()
  const catchUps = new Map<string, Promise<void>>()
  const gapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let activeAt = 0

  const feedFor = (sessionID: string) => {
    const existing = feeds.get(sessionID)
    if (existing) return existing
    const created = createSessionFeed(sessionID, (type, event) => {
      if (type === "session.next.step.ended" || type === "session.next.step.failed")
        setData("streaming_text", sessionID, undefined)
      if (
        type === "session.next.text.ended" &&
        data.streaming_text[sessionID] === adaptPartID(String(event.assistantMessageID), String(event.textID))
      )
        setData("streaming_text", sessionID, undefined)
    })
    feeds.set(sessionID, created)
    return created
  }

  const dropFeed = (sessionID: string) => {
    feeds.delete(sessionID)
    adaptCaches.delete(sessionID)
    written.delete(sessionID)
    catchUps.delete(sessionID)
    const timer = gapTimers.get(sessionID)
    if (timer) clearTimeout(timer)
    gapTimers.delete(sessionID)
  }

  const showExecution = (sessionID: string, active: boolean) => {
    if (!active) {
      setData("session_status", sessionID, reconcile({ type: "idle" }))
      setData("streaming_text", sessionID, undefined)
      return
    }
    const retrying = feeds.get(sessionID)?.retry
    setData("session_status", sessionID, reconcile(retrying ? { type: "retry", ...retrying } : { type: "busy" }))
  }

  /**
   * Status reports are ordered by the reporting process's start time and its change counter. An
   * event applies only if it is newer than what was seen; a request's answer also applies when it
   * is exactly as new, because it reflects every change up to its counter.
   */
  const setExecution = (
    sessionID: string,
    active: boolean,
    version: { epoch: number; revision: number },
    answer: boolean,
  ) => {
    const seen = executions.get(sessionID)
    if (
      seen &&
      (version.epoch < seen.epoch ||
        (version.epoch === seen.epoch &&
          (answer ? version.revision < seen.revision : version.revision <= seen.revision)))
    )
      return
    executions.set(sessionID, { epoch: version.epoch, revision: version.revision })
    showExecution(sessionID, active)
  }

  const refreshActive = async () => {
    const result = await client.v2.session.active({ throwOnError: true, signal: AbortSignal.timeout(10_000) })
    const epoch = result.data.epoch
    const revision = result.data.revision
    if (epoch === undefined || revision === undefined) return
    const working = Object.entries(data.session_status).flatMap(([id, status]) => (status.type === "idle" ? [] : [id]))
    batch(() =>
      new Set([...Object.keys(result.data.data), ...working]).forEach((id) =>
        setExecution(id, result.data.data[id] !== undefined, { epoch, revision }, true),
      ),
    )
  }

  /** Writes the feed's current transcript to the store, touching only what changed. */
  const flush = (sessionID: string) => {
    const feed = feeds.get(sessionID)
    const session = v2Info.get(sessionID)
    if (!feed?.ready || !session) return
    const cache = adaptCaches.get(sessionID) ?? new WeakMap()
    adaptCaches.set(sessionID, cache)
    const adapted = adaptSessionMessages(session, feed.messages() as SessionMessage[], undefined, cache)
    const known = new Set(adapted.map((item) => item.message.id))
    const inputs = feed.pending()
    const context = [session.agent, session.model?.providerID, session.model?.id, session.model?.variant].join("|")
    // Inputs the kernel admitted but has not promoted yet. Background completions are the kernel's
    // own inputs and only appear once promoted, as process records.
    const waiting = inputs.flatMap((input) => {
      if (input.completion || known.has(input.id)) return []
      known.add(input.id)
      const hit = inputCache.get(input)
      if (hit?.key === context) return [hit.value]
      const value = adaptSessionInput(session, input)
      inputCache.set(input, { key: context, value })
      return [value]
    })
    // The local copy of a just-sent message gives way as soon as the kernel's own record of it applies.
    const local = optimistic.get(sessionID)
    if (local) {
      for (const id of [...local.keys()]) if (known.has(id)) local.delete(id)
      if (local.size === 0) optimistic.delete(sessionID)
    }
    const unconfirmed = [...(optimistic.get(sessionID)?.values() ?? [])]
    const items: Adapted[] = [
      ...adapted,
      ...waiting,
      ...unconfirmed.map((item) => ({ message: item.message, parts: item.parts })),
    ]
    const previous = written.get(sessionID) ?? new Map<string, Adapted>()
    const next = new Map(items.map((item) => [item.message.id, item] as const))
    const unconfirmedIDs = new Set(unconfirmed.map((item) => item.message.id))
    batch(() => {
      const restructured =
        data.message[sessionID] === undefined ||
        previous.size !== next.size ||
        [...next.keys()].some((id) => !previous.has(id))
      if (restructured)
        setData(
          "message",
          sessionID,
          reconcile(
            items.map((item) => cleanMessage(item.message)).sort((a, b) => cmp(a.id, b.id)),
            { key: "id" },
          ),
        )
      for (const item of items) {
        const id = item.message.id
        // Local copies are rebuilt on every pass; their content cannot change after they are sent.
        if (previous.get(id) === item || (unconfirmedIDs.has(id) && previous.has(id))) continue
        if (!restructured) {
          const found = Binary.search(data.message[sessionID] ?? [], id, (message) => message.id)
          if (found.found) setData("message", sessionID, found.index, reconcile(cleanMessage(item.message)))
        }
        const parts = item.parts.filter((part) => !!part.id && !SKIP_PARTS.has(part.type))
        if (parts.length) setData("part", id, reconcile(parts, { key: "id" }))
        if (!parts.length) setData(produce((draft) => deleteMessageParts(draft, id)))
      }
      for (const id of previous.keys()) if (!next.has(id)) setData(produce((draft) => deleteMessageParts(draft, id)))
      setData("pending_input", sessionID, reconcile(inputs, { key: "id" }))
      setMeta("limit", sessionID, items.length)
      setMeta("at", sessionID, Date.now())
    })
    written.set(sessionID, next)
  }

  const pageLimit = (limit: number) => Math.min(100, Math.max(initialMessagePageSize, limit))

  /** Reads `session.history` from the feed's sequence until nothing is missing. */
  const catchUp = (sessionID: string) =>
    runInflight(catchUps, sessionID, async () => {
      const feed = feeds.get(sessionID)
      if (!feed?.ready) return
      for (let more = true; more && feeds.get(sessionID) === feed && feed.ready; ) {
        const response = await client.v2.session.history(
          { sessionID, after: feed.applied < 0 ? undefined : feed.applied, limit: 100 },
          { throwOnError: true, signal: AbortSignal.timeout(10_000) },
        )
        feed.history(
          response.data.data.flatMap((event) =>
            event.durable
              ? [
                  {
                    id: event.id,
                    type: event.type + "." + event.durable.version,
                    seq: event.durable.seq,
                    data: event.data,
                  },
                ]
              : [],
          ),
        )
        more = response.data.hasMore
      }
      if (feeds.get(sessionID) === feed) settle(sessionID)
    })

  /** After the feed changed: show it, and arrange for whatever it still needs. */
  const settle = (sessionID: string) => {
    const feed = feeds.get(sessionID)
    if (!feed) return
    if (feed.stale) {
      // Read a new snapshot once whatever request is already running for this session has finished.
      void (inflight.get(sessionID) ?? Promise.resolve())
        .catch(() => {})
        .then(() => (feeds.get(sessionID)?.stale ? sync(sessionID) : undefined))
        .catch(() => {})
      return
    }
    flush(sessionID)
    if (data.session_working(sessionID)) showExecution(sessionID, true)
    if (!feed.gap || gapTimers.has(sessionID)) return
    // Neighbouring events can arrive swapped; only a gap that stays open is worth a request.
    gapTimers.set(
      sessionID,
      setTimeout(() => {
        gapTimers.delete(sessionID)
        if (feeds.get(sessionID)?.gap) void catchUp(sessionID).catch(() => {})
      }, 150),
    )
  }

  /** Adds one older page. Returns whether history grew. */
  const readOlder = async (sessionID: string, count: number) => {
    const feed = feeds.get(sessionID)
    const cursor = meta.cursor[sessionID]
    if (!feed?.ready || !cursor || meta.loading[sessionID]) return false
    const active = generation(sessionID)
    setMeta("loading", sessionID, true)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = feed.generation
        const response = await (options?.retry ?? retry)(() =>
          client.v2.session.messages({ sessionID, limit: pageLimit(count), cursor }),
        )
        const page = response.data
        if (!page || page.watermark === undefined) throw new Error("Unable to load messages: " + sessionID)
        if (generations.get(sessionID) !== active || feeds.get(sessionID) !== feed) return false
        const input = { data: page.data, watermark: page.watermark }
        // The page may have seen events this feed has not applied yet. Apply them first.
        if (feed.behind(input)) await catchUp(sessionID).catch(() => {})
        if (generations.get(sessionID) !== active || feeds.get(sessionID) !== feed) return false
        if (feed.prepend(input, revision) === "merged") {
          batch(() => {
            setMeta("cursor", sessionID, page.cursor.next)
            setMeta("complete", sessionID, !page.cursor.next)
            flush(sessionID)
          })
          return true
        }
        // History was rewritten under the request: the cursor no longer means what it did.
        if (feed.generation !== revision) return false
      }
      return false
    } finally {
      if (generations.get(sessionID) === active) setMeta("loading", sessionID, false)
    }
  }

  /** A turn cut by the page boundary stays hidden until its user message is read. Read a little further. */
  const completeFirstTurn = async (sessionID: string) => {
    for (let pages = 0; pages < 5; pages++) {
      const feed = feeds.get(sessionID)
      if (!feed?.ready || feed.rooted() || !meta.cursor[sessionID]) return
      if (!(await readOlder(sessionID, 50))) return
    }
  }

  const readSnapshot = async (sessionID: string, limit: number) => {
    const active = generation(sessionID)
    // The feed exists before the request leaves, so events that arrive while it is in flight wait for it.
    const feed = feedFor(sessionID)
    setMeta("loading", sessionID, true)
    try {
      const [info, response] = await Promise.all([
        v2Info.get(sessionID) ??
          (options?.retry ?? retry)(() => client.v2.session.get({ sessionID })).then((result) => result.data?.data),
        (options?.retry ?? retry)(() =>
          client.v2.session.messages({ sessionID, limit: pageLimit(limit), order: "desc" }),
        ),
      ])
      if (!info) throw sessionNotFoundError(sessionID)
      const page = response.data
      if (!page || page.watermark === undefined) throw new Error("Unable to load messages: " + sessionID)
      if (generations.get(sessionID) !== active || feeds.get(sessionID) !== feed) return
      v2Info.set(sessionID, info)
      // Another server process may hold a different history; only then may a page move the feed back.
      const seen = executions.get(sessionID)?.epoch
      const restarted = !!page.execution && seen !== undefined && page.execution.epoch !== seen
      const opened = feed.open({ data: page.data, watermark: page.watermark, pending: page.pending }, restarted)
      batch(() => {
        if (opened) {
          setMeta("cursor", sessionID, page.cursor.next)
          setMeta("complete", sessionID, !page.cursor.next)
        }
        if (page.execution) setExecution(sessionID, page.execution.active, page.execution, true)
        settle(sessionID)
      })
    } finally {
      if (generations.get(sessionID) === active) setMeta("loading", sessionID, false)
    }
    await completeFirstTurn(sessionID)
  }

  /** After the stream was interrupted: read what was missed, and the text that is still being written. */
  const recover = async (sessionID: string) => {
    await catchUp(sessionID)
    const feed = feeds.get(sessionID)
    if (!feed?.ready) return
    await Promise.all(
      feed
        .streaming()
        .slice(-2)
        .map(async (messageID) => {
          const response = await client.v2.session.message(
            { sessionID, messageID },
            { throwOnError: true, signal: AbortSignal.timeout(10_000) },
          )
          const message = response.data.data
          if (message.type !== "assistant") return
          for (const part of message.content)
            if (part.type === "text" || part.type === "reasoning") feed.extend(messageID, part.type, part.id, part.text)
        }),
    )
    if (feeds.get(sessionID) === feed) settle(sessionID)
  }

  const applyOrdered = (event: { type: string; properties?: unknown; syncEvent?: unknown }, eventID?: string) => {
    if (event.type === "sync") {
      const item = event.syncEvent as FeedEvent & { aggregateID: string }
      eventAt.set(item.aggregateID, Date.now())
      const feed = feeds.get(item.aggregateID)
      if (!feed) return
      feed.durable(item)
      settle(item.aggregateID)
      return
    }
    if (event.type === "session.execution.status") {
      const props = event.properties as { sessionID: string; active: boolean; epoch: number; revision: number }
      setExecution(props.sessionID, props.active, props, false)
      return
    }
    if (event.type === "session.next.text.delta" || event.type === "session.next.reasoning.delta") {
      const props = event.properties as {
        sessionID: string
        assistantMessageID: string
        textID?: string
        reasoningID?: string
        delta: string
        offset?: number
      }
      const id = props.textID ?? props.reasoningID
      const feed = feeds.get(props.sessionID)
      if (!id || !feed) return
      const kind = props.textID === undefined ? "reasoning" : "text"
      const text = feed.fragment({
        messageID: props.assistantMessageID,
        kind,
        id,
        delta: props.delta,
        offset: props.offset,
      })
      if (text === undefined) return
      const partID = adaptPartID(props.assistantMessageID, id)
      const index = data.part[props.assistantMessageID]?.findIndex((part) => part.id === partID) ?? -1
      if (index < 0) return flush(props.sessionID)
      batch(() => {
        setData(
          "part",
          props.assistantMessageID,
          index,
          produce((part) => {
            if (part.type === "text" || part.type === "reasoning") part.text = text
          }),
        )
        if (kind === "text") setData("streaming_text", props.sessionID, partID)
      })
      return
    }
    if (!eventID) return
    if (event.type === "session.next.deleted") {
      infoSeen.delete(eventID)
      evict([eventID])
      return
    }
    // Everything else about the transcript arrives through the sequenced copy of the same event.
    const selection =
      event.type === "session.next.prompted" &&
      !!(event.properties as { prompt?: { selection?: unknown } }).prompt?.selection
    if (
      selection ||
      event.type === "session.next.updated" ||
      event.type === "session.next.revert.staged" ||
      event.type === "session.next.revert.cleared" ||
      event.type === "session.next.revert.committed"
    )
      void resolve(eventID, { force: true }).catch(() => {})
  }

  const reconnectOrdered = (replayed: boolean) => {
    setData("live_shell", reconcile({}))
    if (!replayed) setData("streaming_text", reconcile({}))
    void refreshActive().catch(() => {})
    for (const sessionID of new Set([...feeds.keys(), ...pinned.keys()])) {
      // Requests and questions are not sequenced, so an open view always re-reads them.
      if (pinned.has(sessionID)) {
        void resync(sessionID).catch(() => {})
        continue
      }
      if (!replayed) void recover(sessionID).catch(() => {})
    }
  }

  const eventSessionID = (event: { type: string; properties?: unknown }) => {
    const properties = event.properties
    if (!properties || typeof properties !== "object") return
    if ("sessionID" in properties && typeof properties.sessionID === "string") return properties.sessionID
    if ("messageID" in properties && typeof properties.messageID === "string") {
      const owner = data.part[properties.messageID]?.[0]?.sessionID
      if (owner) return owner
    }
    if (
      "info" in properties &&
      properties.info &&
      typeof properties.info === "object" &&
      "sessionID" in properties.info &&
      typeof properties.info.sessionID === "string"
    )
      return properties.info.sessionID
    if (
      "part" in properties &&
      properties.part &&
      typeof properties.part === "object" &&
      "sessionID" in properties.part &&
      typeof properties.part.sessionID === "string"
    )
      return properties.part.sessionID
  }

  const apply = (event: { type: string; properties?: unknown }): void => {
    const normalized = adaptServerEvent(event as Event)
    if (normalized !== event) return apply(normalized)
    if (
      !capable &&
      event.type === "server.connected" &&
      (event.properties as { sync?: number } | undefined)?.sync === 1
    ) {
      // A session read before the stream connected was read the old way. Abandon those reads; the
      // feed reads every open session again below.
      messageLoads.clear()
      inflight.clear()
      capable = true
    }
    if (capable && (event.type === "server.connected" || event.type === "global.disposed")) {
      reconnectOrdered(
        event.type === "server.connected" && (event.properties as { replay?: string }).replay === "applied",
      )
      return
    }
    if (event.type === "server.connected" || event.type === "global.disposed") {
      setData("live_shell", reconcile({}))
      setData("streaming_text", reconcile({}))
      pinned.forEach((_, id) => void resync(id).catch(() => {}))
    }
    const eventID = eventSessionID(event)
    if (eventID && ["question.asked", "question.replied", "question.rejected"].includes(event.type))
      questionVersions.set(eventID, (questionVersions.get(eventID) ?? 0) + 1)
    if (eventID && (event.type === "session.next.shell.started" || event.type === "session.next.shell.ended")) {
      const props = event.properties as { messageID?: string; callID?: string }
      const id = event.type === "session.next.shell.started" ? props.messageID : props.callID
      if (id) {
        const jobs = { ...data.live_shell[eventID] }
        if (event.type === "session.next.shell.started") jobs[id] = true
        else delete jobs[id]
        setData("live_shell", eventID, reconcile(jobs))
      }
    }
    if (eventID) {
      eventAt.set(eventID, Date.now())
      eventVersion.set(eventID, {})
      touch(eventID)
      if (
        !data.info[eventID] &&
        event.type !== "session.created" &&
        event.type !== "session.updated" &&
        event.type !== "session.deleted"
      )
        void resolve(eventID).catch(() => {})
    }
    if (
      capable &&
      (event.type === "sync" || event.type === "session.execution.status" || event.type.startsWith("session.next."))
    )
      return applyOrdered(event, eventID)
    if (event.type === "sync") return
    const refreshV2 = (sessionID: string) => {
      const active = generation(sessionID)
      const pending = v2Refreshes.get(sessionID)
      if (pending) clearTimeout(pending)
      v2Refreshes.set(
        sessionID,
        setTimeout(() => {
          v2Refreshes.delete(sessionID)
          void (async () => {
            await inflight.get(sessionID)?.catch(() => {})
            if (generations.get(sessionID) !== active) return
            await sync(sessionID, { force: true })
          })().catch(() => {})
        }, 50),
      )
    }
    if (event.type === "session.next.prompt.cancelled") {
      const props = event.properties as { sessionID: string; messageID: string }
      admitted.get(props.sessionID)?.delete(props.messageID)
      apply({ type: "message.removed", properties: props })
      setData("pending_input", props.sessionID, (items = []) => items.filter((item) => item.id !== props.messageID))
      refreshV2(props.sessionID)
      return
    }
    if (event.type === "session.next.prompted" || event.type === "session.next.prompt.admitted") {
      const props = event.properties as {
        delivery?: "steer" | "queue"
        completion?: SessionInputAdmitted["completion"]
        timestamp: number
        sessionID: string
        messageID: string
        prompt: {
          selection?: SessionInputAdmitted["prompt"]["selection"]
          text: string
          invocation?: string
          files?: { uri: string; mime: string; name?: string }[]
          agents?: { name: string; source?: { text: string; start: number; end: number } }[]
        }
      }
      if (event.type === "session.next.prompt.admitted") {
        const pending = admitted.get(props.sessionID) ?? new Map<string, false | "steer" | "queue">()
        pending.set(props.messageID, props.delivery ?? "steer")
        admitted.set(props.sessionID, pending)
        refreshV2(props.sessionID)
      }
      if (event.type === "session.next.prompted") {
        const current = admitted.get(props.sessionID) ?? new Map<string, false | "steer" | "queue">()
        current.set(props.messageID, false)
        admitted.set(props.sessionID, current)
        setData("pending_input", props.sessionID, (items = []) => items.filter((item) => item.id !== props.messageID))
        if (props.prompt.selection) {
          v2Info.delete(props.sessionID)
          void resolve(props.sessionID, { force: true }).catch(() => {})
        }
      }
      if (props.completion) {
        refreshV2(props.sessionID)
        return
      }
      const session = data.info[props.sessionID]
      if (!session) return refreshV2(props.sessionID)
      apply({
        type: "message.updated",
        properties: {
          info: {
            id: props.messageID,
            sessionID: props.sessionID,
            role: "user",
            time: { created: props.timestamp },
            agent: props.prompt.selection?.agent ?? session.agent ?? "build",
            model: {
              providerID: props.prompt.selection?.model.providerID ?? session.model?.providerID ?? "unknown",
              modelID: props.prompt.selection?.model.id ?? session.model?.id ?? "unknown",
              variant: props.prompt.selection ? props.prompt.selection.model.variant : session.model?.variant,
            },
          },
        },
      })
      if (props.prompt.text)
        apply({
          type: "message.part.updated",
          properties: {
            part: {
              id: `${props.messageID}:text`,
              sessionID: props.sessionID,
              messageID: props.messageID,
              type: "text",
              text: props.prompt.invocation ?? props.prompt.text,
              metadata:
                event.type === "session.next.prompt.admitted"
                  ? { zaovraDelivery: props.delivery ?? "steer" }
                  : undefined,
            },
          },
        })
      props.prompt.files?.forEach((file, index) =>
        apply({
          type: "message.part.updated",
          properties: {
            part: {
              id: `${props.messageID}:file:${index}`,
              sessionID: props.sessionID,
              messageID: props.messageID,
              type: "file",
              mime: file.mime,
              filename: file.name,
              url: file.uri,
            },
          },
        }),
      )
      props.prompt.agents?.forEach((agent, index) =>
        apply({
          type: "message.part.updated",
          properties: {
            part: {
              id: `${props.messageID}:agent:${index}`,
              sessionID: props.sessionID,
              messageID: props.messageID,
              type: "agent",
              name: agent.name,
              source: agent.source
                ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
                : undefined,
            },
          },
        }),
      )
      if (props.delivery !== "queue") setData("session_status", props.sessionID, { type: "busy" })
      return
    }
    if (event.type === "session.next.retried") {
      const props = event.properties as {
        sessionID: string
        timestamp: number
        attempt: number
        error: { message: string; metadata?: Record<string, string> }
      }
      setData("streaming_text", props.sessionID, undefined)
      const delay = Number(props.error.metadata?.delayMs ?? 0)
      setData("session_status", props.sessionID, {
        type: "retry",
        attempt: props.attempt,
        message: props.error.message,
        next: props.timestamp + (Number.isFinite(delay) ? Math.max(0, delay) : 0),
      })
      void watchExecution(props.sessionID).catch(() => {})
      return
    }
    if (event.type === "session.next.step.started") {
      const props = event.properties as {
        timestamp: number
        sessionID: string
        assistantMessageID: string
        agent: string
        model: { id: string; providerID: string; variant?: string }
      }
      setData("session_status", props.sessionID, reconcile({ type: "busy" }))
      void watchExecution(props.sessionID).catch(() => {})
      const session = data.info[props.sessionID]
      const parentID = data.message[props.sessionID]?.findLast(
        (message) => message.role === "user" && !admitted.get(props.sessionID)?.get(message.id),
      )?.id
      if (!session || !parentID) return refreshV2(props.sessionID)
      apply({
        type: "message.updated",
        properties: {
          info: {
            id: props.assistantMessageID,
            sessionID: props.sessionID,
            role: "assistant",
            time: { created: props.timestamp },
            parentID,
            modelID: props.model.id,
            providerID: props.model.providerID,
            mode: "build",
            agent: props.agent,
            path: { cwd: session.directory, root: session.directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            variant: props.model.variant,
          },
        },
      })
      setData("session_status", props.sessionID, { type: "busy" })
      return
    }
    if (event.type === "session.next.text.started" || event.type === "session.next.reasoning.started") {
      const props = event.properties as {
        timestamp: number
        sessionID: string
        assistantMessageID: string
        textID?: string
        reasoningID?: string
      }
      const id = props.textID ?? props.reasoningID
      if (!id) return
      const partID = adaptPartID(props.assistantMessageID, id)
      if (data.part[props.assistantMessageID]?.some((part) => part.id === partID)) return
      apply({
        type: "message.part.updated",
        properties: {
          part: {
            id: partID,
            sessionID: props.sessionID,
            messageID: props.assistantMessageID,
            type: props.textID ? "text" : "reasoning",
            text: "",
            ...(props.reasoningID ? { time: { start: props.timestamp } } : {}),
          },
        },
      })
      return
    }
    if (event.type === "session.next.text.delta" || event.type === "session.next.reasoning.delta") {
      const props = event.properties as {
        sessionID: string
        assistantMessageID: string
        textID?: string
        reasoningID?: string
        delta: string
        offset?: number
      }
      const id = props.textID ?? props.reasoningID
      if (!id) return
      const partID = adaptPartID(props.assistantMessageID, id)
      if (props.textID && props.delta) {
        textDeltas.set(props.sessionID, (textDeltas.get(props.sessionID) ?? 0) + 1)
        setData("streaming_text", props.sessionID, partID)
      }
      if (props.offset !== undefined) {
        const buffered = offsetChunks.get(partID) ?? { sessionID: props.sessionID, chunks: new Map<number, string>() }
        buffered.chunks.set(props.offset, props.delta)
        offsetChunks.set(partID, buffered)
        const part = data.part[props.assistantMessageID]?.find((part) => part.id === partID)
        if (!part || (part.type !== "text" && part.type !== "reasoning")) {
          refreshV2(props.sessionID)
          return
        }
        const text = appendOffsetText(part.text, buffered.chunks)
        if (!messageLoads.has(props.sessionID)) {
          for (const [offset, delta] of buffered.chunks) {
            if (offset + delta.length <= text.length) buffered.chunks.delete(offset)
          }
          if (!buffered.chunks.size) offsetChunks.delete(partID)
        }
        if (props.offset > part.text.length) refreshV2(props.sessionID)
        if (text === part.text) return
        apply({
          type: "message.part.delta",
          properties: {
            sessionID: props.sessionID,
            messageID: props.assistantMessageID,
            partID,
            field: "text",
            delta: text.slice(part.text.length),
          },
        })
        return
      }
      apply({
        type: "message.part.delta",
        properties: {
          sessionID: props.sessionID,
          messageID: props.assistantMessageID,
          partID,
          field: "text",
          delta: props.delta,
        },
      })
      return
    }
    if (event.type === "session.next.text.ended" || event.type === "session.next.reasoning.ended") {
      const props = event.properties as {
        timestamp: number
        sessionID: string
        assistantMessageID: string
        textID?: string
        reasoningID?: string
        text: string
        superseded?: boolean
      }
      const id = props.textID ?? props.reasoningID
      const partID = id ? adaptPartID(props.assistantMessageID, id) : undefined
      const current = partID ? data.part[props.assistantMessageID]?.find((part) => part.id === partID) : undefined
      if (partID) offsetChunks.delete(partID)
      if (props.textID) setData("streaming_text", props.sessionID, undefined)
      // A reconnect can miss text.started; the terminal event carries the full answer.
      // Normal part admission below still requires its ordered parent message.
      const ended =
        current && "text" in current
          ? current
          : props.textID && partID
            ? {
                id: partID,
                sessionID: props.sessionID,
                messageID: props.assistantMessageID,
                type: "text" as const,
                text: "",
                metadata: undefined,
              }
            : undefined
      if (ended)
        apply({
          type: "message.part.updated",
          properties: {
            part: {
              ...ended,
              text: props.superseded
                ? `[被替代的未完成${ended.type === "reasoning" ? "推理" : "输出"}]\n${props.text}`
                : props.text,
              metadata: { ...ended.metadata, ...(props.superseded ? { superseded: true } : {}) },
              ...(ended.type === "reasoning" ? { time: { ...ended.time, end: props.timestamp } } : {}),
            },
          },
        })
      refreshV2(props.sessionID)
      return
    }
    if (event.type === "session.next.step.ended" || event.type === "session.next.step.failed") {
      const props = event.properties as {
        timestamp: number
        sessionID: string
        assistantMessageID: string
        finish?: string
        responseModel?: string
        cost?: number
        tokens?: {
          input: number
          output: number
          reasoning: number
          cache: { read: number; write: number }
        }
        error?: { message: string }
      }
      setData("streaming_text", props.sessionID, undefined)
      const current = data.message[props.sessionID]?.find((message) => message.id === props.assistantMessageID)
      if (current?.role === "assistant") {
        apply({
          type: "message.updated",
          properties: {
            info: {
              ...current,
              time: { ...current.time, completed: props.timestamp },
              finish: props.error ? "error" : props.finish,
              cost: props.cost ?? current.cost,
              tokens: props.tokens ?? current.tokens,
              error: props.error ? { name: "UnknownError", data: { message: props.error.message } } : undefined,
            },
          },
        })
        const model = props.responseModel?.trim()
        if (model)
          data.part[props.assistantMessageID]?.forEach((part) => {
            if (part.type !== "text") return
            apply({
              type: "message.part.updated",
              properties: { part: { ...part, metadata: { ...part.metadata, zaovraResponseModel: model } } },
            })
          })
      }
      void watchExecution(props.sessionID).catch(() => {})
      refreshV2(props.sessionID)
      return
    }
    if (
      event.type === "session.next.tool.called" ||
      event.type === "session.next.tool.progress" ||
      event.type === "session.next.tool.success" ||
      event.type === "session.next.tool.failed" ||
      event.type === "session.next.shell.started" ||
      event.type === "session.next.shell.ended" ||
      event.type === "session.next.compaction.ended" ||
      event.type === "session.next.synthetic"
    ) {
      if (eventID) refreshV2(eventID)
      return
    }
    if (
      (event.type === "session.next.updated" ||
        event.type === "session.next.revert.staged" ||
        event.type === "session.next.revert.cleared" ||
        event.type === "session.next.revert.committed") &&
      eventID
    ) {
      v2Info.delete(eventID)
      void resolve(eventID, { force: true }).catch(() => {})
      return
    }
    if (event.type === "session.next.deleted" && eventID) {
      infoSeen.delete(eventID)
      evict([eventID])
      return
    }
    switch (event.type) {
      case "session.created":
        remember((event.properties as { info: Session }).info)
        return
      case "session.updated": {
        const info = (event.properties as { info: Session }).info
        remember(info)
        if (info.time.archived) evict([info.id])
        return
      }
      case "session.deleted": {
        const sessionID = (event.properties as { info: Session }).info.id
        infoSeen.delete(sessionID)
        setData(
          "info",
          produce((draft) => void delete draft[sessionID]),
        )
        evict([sessionID])
        return
      }
      case "session.diff": {
        const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
        setData("session_diff", props.sessionID, reconcile(cleanDiffs(props.diff), { key: "file" }))
        return
      }
      case "todo.updated": {
        const props = event.properties as { sessionID: string; todos: Todo[] }
        setData("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
        return
      }
      case "session.status": {
        const props = event.properties as { sessionID: string; status: SessionStatus }
        setData("session_status", props.sessionID, reconcile(props.status))
        if (props.status.type === "idle") setData("streaming_text", props.sessionID, undefined)
        return
      }
      case "message.updated": {
        const info = cleanMessage((event.properties as { info: Message }).info)
        const load = messageLoads.get(info.sessionID)
        load?.touchedMessages.add(info.id)
        load?.removedMessages.delete(info.id)
        const items = optimistic.get(info.sessionID)
        const item = items?.get(info.id)
        if (items && item) {
          if (item.parts.length === 0) clearOptimistic(info.sessionID, info.id)
          if (item.parts.length > 0) items.set(info.id, { ...item, confirmedMessage: true })
        }
        const orphans = orphanParts.get(info.sessionID)
        orphans?.delete(info.id)
        if (orphans?.size === 0) orphanParts.delete(info.sessionID)
        const removedMessagesForSession = removedMessages.get(info.sessionID)
        removedMessagesForSession?.delete(info.id)
        if (removedMessagesForSession?.size === 0) removedMessages.delete(info.sessionID)
        const messages = data.message[info.sessionID]
        if (!messages) {
          setData("message", info.sessionID, [info])
          return
        }
        const result = Binary.search(messages, info.id, (message) => message.id)
        if (result.found) setData("message", info.sessionID, result.index, reconcile(info))
        if (!result.found)
          setData("message", info.sessionID, (value = []) => {
            const next = value.slice()
            next.splice(result.index, 0, info)
            return next
          })
        return
      }
      case "message.removed": {
        const props = event.properties as { sessionID: string; messageID: string }
        const load = messageLoads.get(props.sessionID)
        load?.touchedMessages.add(props.messageID)
        load?.removedMessages.add(props.messageID)
        load?.clearedMessageParts.add(props.messageID)
        load?.deltaParts.delete(props.messageID)
        load?.carriedDeltaParts.delete(props.messageID)
        load?.removedParts.delete(props.messageID)
        load?.optimisticParts.delete(props.messageID)
        pendingParts.get(props.sessionID)?.delete(props.messageID)
        if (pendingParts.get(props.sessionID)?.size === 0) pendingParts.delete(props.sessionID)
        const removedMessagesForSession = removedMessages.get(props.sessionID) ?? new Set<string>()
        removedMessagesForSession.add(props.messageID)
        removedMessages.set(props.sessionID, removedMessagesForSession)
        clearOptimistic(props.sessionID, props.messageID)
        setData(
          produce((draft) => {
            const messages = draft.message[props.sessionID]
            if (messages) {
              const result = Binary.search(messages, props.messageID, (message) => message.id)
              if (result.found) messages.splice(result.index, 1)
            }
            deleteMessageParts(draft, props.messageID)
          }),
        )
        return
      }
      case "message.part.updated": {
        const part = (event.properties as { part: Part }).part
        if (SKIP_PARTS.has(part.type)) return
        const messages = data.message[part.sessionID]
        const load = messageLoads.get(part.sessionID)
        const missing = !messages || !Binary.search(messages, part.messageID, (message) => message.id).found
        // Outside a page load, accepting a part without its ordered parent event would create an unbounded orphan.
        if (
          missing &&
          (!load ||
            load.clearedMessageParts.has(part.messageID) ||
            removedMessages.get(part.sessionID)?.has(part.messageID))
        )
          return
        if (missing) {
          const orphans = orphanParts.get(part.sessionID) ?? new Set<string>()
          orphans.add(part.messageID)
          orphanParts.set(part.sessionID, orphans)
          load?.orphanParents.add(part.messageID)
        }
        const deltas = load?.deltaParts.get(part.messageID)
        deltas?.delete(part.id)
        if (deltas?.size === 0) load?.deltaParts.delete(part.messageID)
        const carried = load?.carriedDeltaParts.get(part.messageID)
        carried?.delete(part.id)
        if (carried?.size === 0) load?.carriedDeltaParts.delete(part.messageID)
        const removed = load?.removedParts.get(part.messageID)
        removed?.delete(part.id)
        if (removed?.size === 0) load?.removedParts.delete(part.messageID)
        const pending = pendingParts.get(part.sessionID)?.get(part.messageID)
        pending?.delete(part.id)
        if (pending?.size === 0) pendingParts.get(part.sessionID)?.delete(part.messageID)
        if (pendingParts.get(part.sessionID)?.size === 0) pendingParts.delete(part.sessionID)
        const optimistic = load?.optimisticParts.get(part.messageID)
        optimistic?.delete(part.id)
        if (optimistic?.size === 0) load?.optimisticParts.delete(part.messageID)
        deltaBases.delete(part.id)
        trackPartChange(part.sessionID, part.messageID, part.id)
        confirmOptimisticPart(part.sessionID, part.messageID, part)
        setData(
          "part_text_accum_delta",
          produce((draft) => void delete draft[part.id]),
        )
        const parts = data.part[part.messageID]
        if (!parts) {
          setData("part", part.messageID, [part])
          return
        }
        // Provider IDs are identities, not ordinals. Keep observed/content order
        // while locating updates by ID independently of their display position.
        const index = parts.findIndex((item) => item.id === part.id)
        if (index >= 0) setData("part", part.messageID, index, reconcile(part))
        if (index < 0) setData("part", part.messageID, (value = []) => [...value, part])
        return
      }
      case "message.part.removed": {
        const props = event.properties as { sessionID: string; messageID: string; partID: string }
        // Part removal is event-only on the server, so its tombstone lasts until a later update or eviction.
        const pending = pendingParts.get(props.sessionID) ?? new Map<string, Set<string>>()
        const parts = pending.get(props.messageID) ?? new Set<string>()
        parts.add(props.partID)
        pending.set(props.messageID, parts)
        pendingParts.set(props.sessionID, pending)
        const deltas = messageLoads.get(props.sessionID)?.deltaParts.get(props.messageID)
        deltas?.delete(props.partID)
        if (deltas?.size === 0) messageLoads.get(props.sessionID)?.deltaParts.delete(props.messageID)
        const load = messageLoads.get(props.sessionID)
        const carried = load?.carriedDeltaParts.get(props.messageID)
        carried?.delete(props.partID)
        if (carried?.size === 0) load?.carriedDeltaParts.delete(props.messageID)
        if (load) {
          const parts = load.removedParts.get(props.messageID) ?? new Set<string>()
          parts.add(props.partID)
          load.removedParts.set(props.messageID, parts)
          const optimistic = load.optimisticParts.get(props.messageID)
          optimistic?.delete(props.partID)
          if (optimistic?.size === 0) load.optimisticParts.delete(props.messageID)
        }
        trackPartChange(props.sessionID, props.messageID, props.partID)
        clearOptimisticPart(props.sessionID, props.messageID, props.partID)
        setData(
          produce((draft) => {
            delete draft.part_text_accum_delta[props.partID]
            deltaBases.delete(props.partID)
            offsetChunks.delete(props.partID)
            const parts = draft.part[props.messageID]
            if (!parts) return
            const index = parts.findIndex((part) => part.id === props.partID)
            if (index >= 0) parts.splice(index, 1)
            if (parts.length === 0) delete draft.part[props.messageID]
          }),
        )
        return
      }
      case "message.part.delta": {
        const props = event.properties as {
          sessionID: string
          messageID: string
          partID: string
          field: string
          delta: string
        }
        const parts = data.part[props.messageID]
        if (!parts) return
        const index = parts.findIndex((part) => part.id === props.partID)
        if (index < 0) return
        trackPartChange(props.sessionID, props.messageID, props.partID)
        const load = messageLoads.get(props.sessionID)
        if (load) {
          const parts = load.deltaParts.get(props.messageID) ?? new Set<string>()
          parts.add(props.partID)
          load.deltaParts.set(props.messageID, parts)
          const carried = load.carriedDeltaParts.get(props.messageID)
          carried?.delete(props.partID)
          if (carried?.size === 0) load.carriedDeltaParts.delete(props.messageID)
        }
        const field = props.field as keyof (typeof parts)[number]
        const current = parts[index]?.[field]
        if (!deltaBases.has(props.partID) && typeof current === "string")
          deltaBases.set(props.partID, { base: current, sessionID: props.sessionID })
        setData(
          "part_text_accum_delta",
          props.partID,
          (value) => (value ?? (typeof current === "string" ? current : "")) + props.delta,
        )
        setData(
          "part",
          props.messageID,
          produce((draft) => {
            if (!draft) return
            const part = draft[index]
            const field = props.field as keyof typeof part
            ;(part[field] as string) = ((part[field] as string | undefined) ?? "") + props.delta
          }),
        )
        return
      }
      case "permission.asked": {
        const permission = event.properties as PermissionView
        const permissions = data.permission[permission.sessionID]
        if (!permissions) {
          setData("permission", permission.sessionID, [permission])
          return
        }
        const result = Binary.search(permissions, permission.id, (item) => item.id)
        if (result.found) setData("permission", permission.sessionID, result.index, reconcile(permission))
        if (!result.found)
          setData(
            "permission",
            permission.sessionID,
            produce((draft) => void draft.splice(result.index, 0, permission)),
          )
        return
      }
      case "permission.replied": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "permission",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
        return
      }
      case "question.asked": {
        const question = event.properties as QuestionView
        const questions = data.question[question.sessionID]
        if (!questions) {
          setData("question", question.sessionID, [question])
          return
        }
        const result = Binary.search(questions, question.id, (item) => item.id)
        if (result.found) setData("question", question.sessionID, result.index, reconcile(question))
        if (!result.found)
          setData(
            "question",
            question.sessionID,
            produce((draft) => void draft.splice(result.index, 0, question)),
          )
        return
      }
      case "question.replied":
      case "question.rejected": {
        const props = event.properties as { sessionID: string; requestID: string }
        setData(
          "question",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
      }
    }
  }

  // Both directory bootstrap and current-view recovery use this single writer.
  const syncQuestions = (directory: string) =>
    runInflight(questionLoads, directory, async () => {
      const versions = new Map(questionVersions)
      const questions = await client.v2.question.request.list(
        { location: { directory } },
        { throwOnError: true, signal: AbortSignal.timeout(10_000) },
      )
      await Promise.all([...new Set(questions.data.data.map((item) => item.sessionID))].map((id) => resolve(id)))
      batch(() => {
        const ids = new Set([...Object.keys(data.question), ...questions.data.data.map((item) => item.sessionID)])
        for (const id of ids) {
          if (data.info[id]?.directory !== directory || questionVersions.get(id) !== versions.get(id)) continue
          setData(
            "question",
            id,
            reconcile(
              questions.data.data.filter((item) => item.sessionID === id).sort((a, b) => cmp(a.id, b.id)),
              { key: "id" },
            ),
          )
        }
      })
    })

  const resync = (sessionID: string) =>
    runInflight(resyncs, sessionID, async () => {
      const active = generation(sessionID)
      const version = eventVersion.get(sessionID)
      const session = await resolve(sessionID, { force: true })
      if (capable) {
        // Questions and permission requests are not sequenced, so they are read again. The transcript
        // only needs what it missed, and status is ordered by its own version.
        const [, permissions] = await Promise.all([
          syncQuestions(session.directory).catch(() => undefined),
          client.v2.permission.request
            .list(
              { location: { directory: session.directory } },
              { throwOnError: true, signal: AbortSignal.timeout(10_000) },
            )
            .catch(() => undefined),
          refreshActive().catch(() => undefined),
          feeds.get(sessionID)?.ready ? recover(sessionID) : sync(sessionID),
        ])
        if (generations.get(sessionID) !== active || eventVersion.get(sessionID) !== version || !permissions) return
        setData(
          "permission",
          sessionID,
          reconcile(
            permissions.data.data.map(adaptPermissionRequest).filter((item) => item.sessionID === sessionID),
            { key: "id" },
          ),
        )
        return
      }
      const [, ownership, permissions] = await Promise.all([
        syncQuestions(session.directory).catch(() => undefined),
        client.v2.session.active({ throwOnError: true, signal: AbortSignal.timeout(10_000) }).catch(() => undefined),
        client.v2.permission.request
          .list(
            { location: { directory: session.directory } },
            { throwOnError: true, signal: AbortSignal.timeout(10_000) },
          )
          .catch(() => undefined),
      ])
      if (generations.get(sessionID) !== active) return
      if (eventVersion.get(sessionID) === version) {
        if (permissions)
          setData(
            "permission",
            sessionID,
            reconcile(
              permissions.data.data.map(adaptPermissionRequest).filter((item) => item.sessionID === sessionID),
              { key: "id" },
            ),
          )
      }
      await inflight.get(sessionID)?.catch(() => {})
      if (generations.get(sessionID) !== active) return
      await sync(sessionID, { force: true })
      if (generations.get(sessionID) !== active || eventVersion.get(sessionID) !== version || !ownership) return
      if (!ownership.data.data[sessionID] && [...(admitted.get(sessionID)?.values() ?? [])].some(Boolean)) return
      setData("session_status", sessionID, ownership.data.data[sessionID] ? { type: "busy" } : { type: "idle" })
      if (!ownership.data.data[sessionID]) setData("streaming_text", sessionID, undefined)
    })

  return {
    data,
    resync,
    questions: { sync: syncQuestions },
    resyncSilent(now = Date.now()): Promise<unknown> {
      if (capable) {
        // A session that claims to be working but has been silent for a while is asked about once.
        // Nothing is re-read; the answer is ordered against status events by its version.
        const silent = Object.entries(data.session_status).some(
          ([id, status]) => status.type !== "idle" && now - (eventAt.get(id) ?? 0) >= 30_000,
        )
        if (!silent || now - activeAt < 30_000) return Promise.resolve()
        activeAt = now
        return refreshActive()
      }
      const refreshViews = now - silentAt >= 15_000
      if (refreshViews) silentAt = now
      const views = refreshViews ? [...pinned.keys()].filter((id) => now - (eventAt.get(id) ?? 0) >= 15_000) : []
      return Promise.all([
        // A failed final ownership request must also recover after its view unmounts.
        ...Object.entries(data.session_status)
          .filter(([id, status]) => status.type !== "idle" && !executionWaits.has(id) && !views.includes(id))
          .map(([id]) => watchExecution(id)),
        ...views.map(resync),
      ])
    },
    stopped: (messageID: string) => stoppedTurns[messageID] !== undefined,
    async interrupt(sessionID: string) {
      const active = generation(sessionID)
      const messages = data.message[sessionID] ?? []
      const user = data.session_working(sessionID)
        ? messages.toSorted(cmpMessage).findLast((message) => message.role === "user")
        : undefined
      await client.v2.session.interrupt({ sessionID }, { throwOnError: true })
      // A missed start event or failed earlier watch must not leave a confirmed Stop busy forever.
      void watchExecution(sessionID).catch(() => {})
      // Capture before awaiting: a newly admitted prompt must never inherit the old Stop.
      if (
        !user ||
        generations.get(sessionID) !== active ||
        !data.message[sessionID]?.some((message) => message.id === user.id)
      )
        return
      if (
        (data.message[sessionID] ?? []).some(
          (message) =>
            message.role === "assistant" &&
            message.parentID === user.id &&
            (data.part[message.id] ?? []).some(
              (part) =>
                part.type === "tool" || ((part.type === "text" || part.type === "reasoning") && part.text.trim()),
            ),
        )
      )
        return
      setStoppedTurns(user.id, sessionID)
    },
    set: setData,
    get: (sessionID: string) => data.info[sessionID],
    peek: (sessionID: string) => data.info[sessionID],
    messageConfirmed: (sessionID: string, messageID: string) =>
      !!data.message[sessionID]?.some((message) => message.id === messageID) &&
      (!optimistic.get(sessionID)?.has(messageID) || !!optimistic.get(sessionID)?.get(messageID)?.confirmedMessage),
    /** Whether the server sequences Session events, so this store follows sessions without re-reading pages. */
    ordered: () => capable,
    remember,
    resolve,
    lineage: {
      peek: peekLineage,
      async resolve(sessionID: string) {
        const session = await resolve(sessionID)
        return { session, root: await rootSession(session, resolve) }
      },
    },
    sync,
    watchExecution,
    pendingDelivery(sessionID: string, messageID: string) {
      const inputs = data.pending_input[sessionID] ?? []
      const parts = data.part[messageID] ?? []
      if (capable) {
        // Admitted inputs come from the kernel; a message it has not confirmed yet is still local.
        const admittedDelivery = inputs.find((input) => input.id === messageID)?.delivery
        if (admittedDelivery) return admittedDelivery
        if (!optimistic.get(sessionID)?.has(messageID)) return
        const local = parts.find((part) => part.type === "text")?.metadata?.zaovraDelivery
        return local === "steer" || local === "queue" ? local : undefined
      }
      const known = admitted.get(sessionID)?.get(messageID)
      if (known === false) return
      if (known) return known
      const delivery = inputs.find((input) => input.id === messageID)?.delivery
      if (delivery) return delivery
      const value = parts.find((part) => part.type === "text")?.metadata?.zaovraDelivery
      return value === "steer" || value === "queue" ? value : undefined
    },
    prefetch,
    shouldPrefetch(sessionID: string, limit: number) {
      if (capable) return !feeds.get(sessionID)?.ready
      if (data.message[sessionID] === undefined) return true
      if (Date.now() - (meta.at[sessionID] ?? 0) > 15_000) return true
      if (meta.complete[sessionID]) return false
      return (meta.limit[sessionID] ?? 0) <= limit
    },
    fresh(sessionID: string, ttl: number) {
      // A followed session is current by construction, however long ago it last changed.
      if (capable && feeds.get(sessionID)?.ready) return true
      return Date.now() - (meta.at[sessionID] ?? 0) <= ttl
    },
    optimistic: {
      add(input: { sessionID: string; message: Message; parts: Part[]; delivery?: "steer" | "queue" }) {
        const delivery = input.delivery ?? input.parts.find((part) => part.type === "text")?.metadata?.zaovraDelivery
        if (delivery === "steer" || delivery === "queue") {
          const pending = admitted.get(input.sessionID) ?? new Map<string, false | "steer" | "queue">()
          if (pending.get(input.message.id) !== false) pending.set(input.message.id, delivery)
          admitted.set(input.sessionID, pending)
        }
        const parts = input.parts.filter((part) => !!part?.id && !SKIP_PARTS.has(part.type))
        if (capable) {
          const items = optimistic.get(input.sessionID) ?? new Map<string, OptimisticItem>()
          items.set(input.message.id, { message: input.message, parts })
          optimistic.set(input.sessionID, items)
          if (feeds.get(input.sessionID)?.ready && v2Info.has(input.sessionID)) return flush(input.sessionID)
          // Sent before the session was first read: show it now, the first snapshot merges it.
          setData("message", input.sessionID, (messages = []) =>
            merge(messages, [input.message]).sort((a, b) => cmp(a.id, b.id)),
          )
          setData("part", input.message.id, parts)
          return
        }
        const load = messageLoads.get(input.sessionID)
        if (load?.clearedMessageParts.has(input.message.id)) {
          const touched = load.touchedParts.get(input.message.id) ?? new Set<string>()
          parts.forEach((part) => touched.add(part.id))
          load.touchedParts.set(input.message.id, touched)
        }
        if (load) {
          load.removedMessages.delete(input.message.id)
          load.optimisticParts.set(input.message.id, new Set(parts.map((part) => part.id)))
        }
        const items = optimistic.get(input.sessionID)
        const removedMessagesForSession = removedMessages.get(input.sessionID)
        removedMessagesForSession?.delete(input.message.id)
        if (removedMessagesForSession?.size === 0) removedMessages.delete(input.sessionID)
        if (items) items.set(input.message.id, { ...input, parts, confirmedParts: [] })
        if (!items)
          optimistic.set(input.sessionID, new Map([[input.message.id, { ...input, parts, confirmedParts: [] }]]))
        setData("message", input.sessionID, (messages = []) =>
          merge(messages, [input.message]).sort((a, b) => cmp(a.id, b.id)),
        )
        setData(
          "part_text_accum_delta",
          produce((draft) => {
            for (const part of [...(data.part[input.message.id] ?? []), ...parts]) {
              delete draft[part.id]
              deltaBases.delete(part.id)
            }
          }),
        )
        setData("part", input.message.id, parts)
      },
      remove(input: { sessionID: string; messageID: string }) {
        const item = optimistic.get(input.sessionID)?.get(input.messageID)
        if (!item) return
        if (capable) {
          clearOptimistic(input.sessionID, input.messageID)
          if (feeds.get(input.sessionID)?.ready && v2Info.has(input.sessionID)) return flush(input.sessionID)
          setData("message", input.sessionID, (messages) =>
            messages?.filter((message) => message.id !== input.messageID),
          )
          setData(produce((draft) => deleteMessageParts(draft, input.messageID)))
          return
        }
        messageLoads.get(input.sessionID)?.optimisticParts.delete(input.messageID)
        clearOptimistic(input.sessionID, input.messageID)
        admitted.get(input.sessionID)?.delete(input.messageID)
        if (item.confirmedMessage) {
          const partIDs = new Set(item.parts.map((part) => part.id))
          setData(
            produce((draft) => {
              for (const part of item.parts) {
                delete draft.part_text_accum_delta[part.id]
                deltaBases.delete(part.id)
              }
              const parts = draft.part[input.messageID]
              if (!parts) return
              draft.part[input.messageID] = parts.filter((part) => !partIDs.has(part.id))
              if (draft.part[input.messageID]?.length === 0) delete draft.part[input.messageID]
            }),
          )
          return
        }
        setData("message", input.sessionID, (messages) => messages?.filter((message) => message.id !== input.messageID))
        setData(produce((draft) => deleteMessageParts(draft, input.messageID)))
      },
    },
    diff(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.session_diff[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightDiff, sessionID, async () => {
        const active = generation(sessionID)
        const session = await resolve(sessionID)
        return client.vcs.diff({ mode: "git", directory: session.directory }).then((result) => {
          if (generations.get(sessionID) !== active) return
          setData("session_diff", sessionID, reconcile(cleanDiffs(result.data ?? []), { key: "file" }))
        })
      })
    },
    todo(sessionID: string, options?: { force?: boolean }) {
      touch(sessionID)
      if (data.todo[sessionID] !== undefined && !options?.force) return Promise.resolve()
      return runInflight(inflightTodo, sessionID, () => {
        const active = generation(sessionID)
        return retry(() => client.v2.session.todos({ sessionID })).then((result) => {
          if (generations.get(sessionID) !== active) return
          setData("todo", sessionID, reconcile(result.data?.data ?? [], { key: "content" }))
        })
      })
    },
    history: {
      complete: (sessionID: string) => meta.complete[sessionID] === true,
      more: (sessionID: string) =>
        data.message[sessionID] !== undefined &&
        meta.limit[sessionID] !== undefined &&
        !meta.complete[sessionID] &&
        !!meta.cursor[sessionID],
      loading: (sessionID: string) => meta.loading[sessionID] ?? false,
      async loadMore(sessionID: string, count = historyMessagePageSize) {
        touch(sessionID)
        if (meta.loading[sessionID] || meta.complete[sessionID] || !meta.cursor[sessionID]) return
        if (capable) {
          if (await readOlder(sessionID, count)) await completeFirstTurn(sessionID)
          return
        }
        await loadMessages(sessionID, count, meta.cursor[sessionID], "prepend")
      },
    },
    evict(sessionID: string) {
      if (protectedSessions().has(sessionID)) return
      seen.delete(sessionID)
      evict([sessionID])
    },
    pin(sessionID: string) {
      pinned.set(sessionID, (pinned.get(sessionID) ?? 0) + 1)
      touch(sessionID)
    },
    unpin(sessionID: string) {
      const count = pinned.get(sessionID)
      if (!count || count === 1) pinned.delete(sessionID)
      if (count && count > 1) pinned.set(sessionID, count - 1)
    },
    apply,
  }
}

export type ServerSession = ReturnType<typeof createServerSession>
