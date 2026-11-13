# Desktop session sync

How the desktop app keeps one session's transcript equal to the kernel's, without duplicates, losses or reordering. The replay tests in `packages/app-ui/test-replay` and the feed tests in `packages/app-ui/src/context/session-feed.test.ts` assert the invariants at the end of this document.

The client side lives in `packages/app-ui/src/context/session-feed.ts` (the rules, no I/O) and the "Ordered feed" part of `server-session.ts` (requests and the store).

## What the kernel guarantees

- **Durable events.** Every `session.next.*` event except stream fragments is durable and carries a per-session sequence number that starts at 0 and never skips.
- **Live events.** `text.delta`, `reasoning.delta`, `tool.input.delta` and `compaction.delta` are not stored and have no sequence number. Text and reasoning fragments carry `offset`, the UTF-16 length of the text before the fragment. The matching `ended` event is durable and carries the full text.
- **Atomic projection.** Writing a durable event, advancing the sequence and updating the message rows happen in one database transaction. Subscribers are notified after the commit.
- **Message order.** Each message carries `seq`, the sequence of the event that created it. That is the transcript order.
- **Turn.** Each message carries `turn`, the user message it was produced for (see below).
- **Live overlay.** A message read, whether a page or a single message, includes text that is still streaming.
- **Catch-up.** `session.history(after, limit)` returns durable events after a sequence, in order. It leaves out event types that are not part of the public session log, so the sequences it returns may skip.

Notification order is not guaranteed to match sequence order when two publishers commit close together, the event stream can drop, and applying one durable event twice is not safe (`text.started` would add a second part). The rules below exist for those three facts.

## The event stream

The global event stream carries every event as `{ id, type, properties }`. Each durable event is followed by a second entry, `{ type: "sync", syncEvent: { id, type, seq, aggregateID, data } }`, where `type` is the versioned type and `data` is the stored form. The client builds transcripts only from the `sync` entries and from stream fragments. It ignores the first copy of a durable `session.next.*` event for transcript purposes.

On connect the server sends `server.connected` with `sync: 1`. Without it the client falls back to re-reading pages, which is how it worked before this document.

## Rules

### Snapshots carry a watermark

A message page returns, read in one transaction:

- `watermark`: the session's latest durable sequence. The page reflects exactly the durable events up to it. Streaming text in the page may be newer; a text part only grows until its `ended` event.
- `pending`: inputs admitted and not yet promoted or cancelled.

and, read right after it, `execution` (see "Busy and idle").

### Durable events apply once, in order

The client tracks `applied`, the highest sequence applied without a gap.

| Incoming sequence | Action                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `<= applied`      | Drop.                                                                                                                            |
| `applied + 1`     | Apply, advance, then drain any buffered successors.                                                                              |
| `> applied + 1`   | Buffer. If the gap is still open 150 ms later, read `session.history(after = applied)` until it reports nothing more is waiting. |

Applying means running the kernel's own event-to-message reducer (`@zaovra-ai/schema/session-message-updater`), plus the three things the kernel's projector does around it:

- `prompt.admitted` adds a pending input; `prompted` and `prompt.cancelled` remove it.
- `revert.committed` removes every message and pending input recorded after the boundary message. If the boundary message is not held, nothing held survives: the client stops applying events and reads a new snapshot.
- An event whose type the client does not know advances `applied` and changes nothing. An event of a known type whose data cannot be decoded is different: applying it wrongly would silently diverge, so the client reads a new snapshot instead.

Events read from `session.history` are applied in the order returned. A sequence the response skips is not a gap.

### Opening

The event stream is always open, so events that arrive while a snapshot is in flight are buffered, not lost. When the snapshot lands, `applied` becomes its watermark, buffered events at or below it are dropped and the rest apply in order.

A later snapshot is accepted only if its watermark is not behind `applied`. The one exception is a snapshot from a different server process (its `execution.epoch` differs from the one seen before): that process may hold a different history, so its page replaces what is held.

### Older pages

The client holds a contiguous run of the newest messages and keeps the last 1024 applied durable events. An older page with watermark `w` is merged like this:

1. `w > applied`: the page has seen events the client has not applied. The client catches up through `session.history` first. A page never moves `applied`.
2. `w <= applied`: every kept event with a sequence above `w` is replayed onto the page alone before it is merged. During that replay an event may change the page's messages but never add one: every message created after `w` is newer than the page. A step start closes the page's last unfinished assistant only if no newer assistant existed at that point, which is how the kernel decides it.
3. If the kept events do not reach back to `w`, or history was rewritten (a revert, a new snapshot) since the page was requested, the page is discarded and requested again.

Only messages older than the oldest held message are taken from the page.

### Stream fragments merge by offset, and `ended` wins

For a part with current length `L` and a fragment at offset `o`:

| Case                 | Action                                                             |
| -------------------- | ------------------------------------------------------------------ |
| `o <= L`             | Append the portion of the fragment beyond `L`.                     |
| `o > L`              | Hold the fragment until the gap closes or the part ends.           |
| part not created yet | Hold per part, bounded, until its durable `started` event applies. |
| no offset            | Append to a known part. An older kernel sends fragments this way.  |

The durable `ended` event sets the text and marks the part ended. After that nothing changes the part: not a late fragment, not a late answer to a read. A message whose step has ended is closed the same way.

After a reconnect that could not replay what was missed, the client reads `session.history`, then reads each message that is still streaming and takes its text only if it extends what is shown and the part has not ended. Tool input fragments are not shown; a tool call appears when its input is complete.

### Turn ownership

`turn` is the user message a message was produced for. A user message is its own turn. A background completion belongs to the turn of the assistant message that launched the command. Anything else continues the turn of the message before it. The value is written once, when the message is created, and never changes. Messages written before this field existed have none and are not backfilled.

`turn` is display ownership. It does not give a session drain a durable identity.

In the UI a reply's parent is the nearest preceding user message, shell record or notice in sequence order, which no later event can change. A shell record or notice is then placed under its recorded `turn` when that user message is loaded; without one, the older timestamp rules apply.

### Busy and idle

The kernel's run coordinator publishes a live `session.execution.status` event whenever a session enters or leaves its set of active sessions. Each report carries `epoch` (the start time of the reporting process) and `revision` (a counter of status changes in that process). A message page and `session.active` return the same pair with the current value.

The client keeps, per session, the highest `(epoch, revision)` it has seen. An event applies only if it is higher. An answer to a request also applies when it is equal, because it reflects every change up to its revision. A slow answer therefore cannot overwrite a newer event, and a restarted process outranks the one before it.

A crashed process never reports that it stopped, so the client asks `session.active` when the event stream reconnects, and once when a session has claimed to be working for 30 seconds without any event. It does not poll otherwise. A queued input that has not started does not make a session busy.

### Reconnect

On `server.connected` the client asks `session.active`. If the server could not replay the missed events (`replay` is not `applied`), each followed session reads `session.history(after = applied)` and the text of messages that are still streaming. Open views also re-read their permission requests and questions, which are not sequenced.

### Pending inputs

The client's local copy of a just-sent message is replaced as soon as the kernel's record of it applies, as a pending input or as a transcript message. Background completions are the kernel's own inputs and are shown only once promoted.

## Invariants

1. While following a session with no stream loss, the client reads no message pages, and reads history only when a caller explicitly asks for current state (the app does so once when a turn ends, as a safety net for events lost without a visible gap). Request count does not grow with the number of tool calls.
2. No message ID appears twice; no part ID appears twice within a message.
3. After every event, including stream fragments, incrementally built state equals a fresh snapshot.
4. After an `ended` event, the part equals the event's text, whatever arrives later.
5. Status is the newest report by `(epoch, revision)`. Once the kernel has nothing left to do, the session reads as idle.
6. A reply's parent never changes, and a recorded `turn` never changes.
7. Swapped neighbours, repeated events and a dropped stream followed by reconnect all converge to the same state as in-order delivery.
8. Loading the newest page and paging back to the first message yields the full transcript, regardless of events, reverts and requests arriving in between.
9. A rendered row keeps its key while its message exists. Rows may leave the DOM when scrolled away and disappear when their message is reverted or deleted.

## Compatibility

All kernel changes add fields or events; an older client ignores them. A client connected to a server that does not announce `sync` re-reads pages as before. That path is kept for one release and then removed.
