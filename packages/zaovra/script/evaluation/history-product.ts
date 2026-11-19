import path from "node:path"
import { DateTime, Effect, ManagedRuntime } from "effect"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { MemoryPages } from "@zaovra-ai/core/memory/pages"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryTidyStore } from "@zaovra-ai/core/memory/tidy-store"
import { ModelV2 } from "@zaovra-ai/core/model"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath, RelativePath } from "@zaovra-ai/core/schema"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { Memory } from "@zaovra-ai/schema/memory"
import { historyText, type Corpus, type PageDrafts } from "./history-library"

export const arms = ["search", "pages", "both"] as const
export type Arm = (typeof arms)[number]
const nodes = LayerNode.group([
  Database.node,
  MemoryStore.node,
  MemoryPages.node,
  MemoryTidyStore.node,
  EventV2.node,
  SessionProjector.node,
])

export async function openLibrary(directory: string, arm: Arm, corpus: Corpus, drafts: PageDrafts) {
  const runtime = ManagedRuntime.make(
    AppNodeBuilder.build(nodes, [[Database.node, Database.layerFromPath(path.join(directory, "retrieval.sqlite"))]]),
  )
  const place = { project: Project.ID.global, directory }
  const scope = MemoryStore.scope(place)
  const documents = new Map<SessionSchema.ID, string>()
  const pagesByRef = new Map<string, Memory.PageID>()
  const notes = new Map<Memory.ID, string>()
  const seed = Effect.gen(function* () {
    const { db } = yield* Database.Service
    const memory = yield* MemoryStore.Service
    const pages = yield* MemoryPages.Service
    const tidy = yield* MemoryTidyStore.Service
    const events = yield* EventV2.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: place.project, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .run()
    const model = { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") }
    const create = (sessionID: SessionSchema.ID, title: string, timestamp: DateTime.Utc) =>
      events.publish(SessionEvent.Created, {
        sessionID,
        timestamp,
        projectID: place.project,
        location: { directory: AbsolutePath.make(directory) },
        subpath: RelativePath.make(""),
        title,
        slug: sessionID,
        version: "evaluation",
        model,
      })
    if (arm !== "pages") {
      // Project the corpus using the normal durable event, without starting a session runner.
      for (const [index, document] of corpus.documents.entries()) {
        const sessionID = SessionSchema.ID.make("ses_" + document.id)
        const timestamp = DateTime.makeUnsafe(index)
        documents.set(sessionID, document.id)
        yield* create(sessionID, document.title, timestamp)
        yield* events.publish(SessionEvent.Prompted, {
          sessionID,
          timestamp,
          messageID: SessionMessage.ID.make("msg_" + document.id),
          prompt: { text: historyText(document.text), files: [], agents: [] },
          delivery: "steer",
        })
      }
    }
    if (arm !== "search") {
      const task = yield* tidy.create(
        { requestID: "history-page-import", scope, directory, model, tokens: 100, dailyTokens: 100 },
        (sessionID) =>
          create(sessionID, "Evaluation page import", DateTime.makeUnsafe(0)).pipe(
            Effect.andThen(
              SessionInput.admit(db, events, {
                id: SessionMessage.ID.create(),
                sessionID,
                prompt: { text: "Import frozen evaluation pages." },
                delivery: "steer",
              }),
            ),
            Effect.map((input) => ({ id: input.id, seq: input.admittedSeq })),
          ),
      )
      const sourceByDoc = new Map<string, Memory.PageSource>()
      for (const document of corpus.documents) {
        // Public tools see the page, never its backing note. The note pins the source digest only.
        const note = yield* memory.write({
          scope,
          kind: "practice",
          origin: "user",
          status: "verified",
          text: "Evaluation source SHA-256 " + corpus.sources[document.id].sha256,
          verification: "Pinned isolated corpus",
        })
        if (!note) throw new Error("missing-page-source")
        notes.set(note.id, document.id)
        sourceByDoc.set(document.id, MemoryPages.source(note))
      }
      for (const [index, draft] of drafts.pages.entries()) {
        const page = yield* pages.publish(
          { sessionID: task.session_id, scope, enabled: true },
          { ...draft, sources: draft.sources.map((id) => sourceByDoc.get(id)!) },
        )
        if (page.status !== "current" || [...pagesByRef.values()].includes(page.id))
          throw new Error("unexpected-published-page")
        pagesByRef.set("p" + (index + 1), page.id)
      }
      yield* tidy.finish(task.id, "completed")
    }
  })
  try {
    await runtime.runPromise(seed)
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  return {
    inventory: { history: documents.size, pages: pagesByRef.size },
    close: () => runtime.dispose(),
    search: async (query: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const memory = yield* MemoryStore.Service
          const found = yield* memory.search({ scope, place, query })
          return found.sessions.flatMap((session) => {
            const source = documents.get(session.sessionID)
            if (!source) throw new Error("search-returned-an-unregistered-source")
            return session.passages.map((passage) => ({
              title: session.title,
              text: passage.text,
              sources: [source],
            }))
          })
        }),
      ),
    list: async (query: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const pages = yield* MemoryPages.Service
          const words = MemoryStore.terms(query)
          const refs = new Map([...pagesByRef].map(([ref, id]) => [id, ref]))
          return (yield* pages.list(scope))
            .map((page) => ({
              ref: refs.get(page.id)!,
              title: page.title,
              summary: page.summary,
              score: MemoryStore.relevance(page.title + " " + page.summary, words),
            }))
            .filter((page) => words.length === 0 || page.score > 0)
            .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref, "en", { numeric: true }))
            .slice(0, 10)
            .map(({ ref, title, summary }) => ({ ref, title, summary }))
        }),
      ),
    read: async (ref: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const pages = yield* MemoryPages.Service
          const id = pagesByRef.get(ref)
          const page = id ? yield* pages.get(scope, id) : undefined
          if (!page || page.status !== "current") return undefined
          return {
            title: page.title,
            text: page.body,
            sources: page.sources.map((source) => notes.get(source.id)!),
          }
        }),
      ),
  }
}
