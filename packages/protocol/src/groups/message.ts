import { Session } from "@zaovra-ai/schema/session"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { SessionInput } from "@zaovra-ai/schema/session-input"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError, SessionNotFoundError, UnknownError } from "../errors"

export const SessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of messages to return. When omitted, the endpoint returns its default page size.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Message order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order.",
    }),
  ),
}).annotate({ identifier: "SessionMessagesQuery" })

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      query: SessionMessagesQuery,
      success: Schema.Struct({
        data: Schema.Array(SessionMessage.Message),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
        // The page reflects exactly the durable events up to this sequence (specs/v2/desktop-sync.md).
        watermark: Schema.Int.pipe(Schema.optional),
        execution: Schema.Struct({
          epoch: Schema.Finite,
          revision: Schema.Int,
          active: Schema.Boolean,
        }).pipe(Schema.optional),
        pending: Schema.Array(SessionInput.Admitted).pipe(Schema.optional),
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.messages",
        summary: "Get session messages",
        description:
          "Retrieve projected messages for a session. Items keep the requested order across pages; use cursor.next or cursor.previous to move through the ordered timeline.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "messages",
      description: "Experimental message routes.",
    }),
  )
