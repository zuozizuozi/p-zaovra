# Desktop session sync

How the desktop app keeps one session's transcript equal to the kernel's, without duplicates, losses or reordering. The replay tests in `packages/app-ui/test-replay` assert the invariants at the end of this document.

## What the kernel already guarantees

- **Durable events.** Every `session.next.*` event except stream fragments is durable and carries a per-session sequence number that starts at 0 and never skips.
- **Live events.** `text.delta`, `reasoning.delta`, `tool.input.delta` and `compaction.delta` are not stored and have no sequence number. Text and reasoning fragments carry `offset`, the UTF-16 length of the text before the fragment. The matching `ended` event is durable and carries the full text.
- **Atomic projection.** Writing a durable event, advancing the sequence and updating the message rows happen in one database transaction. Subscribers are notified after the commit.
- **Message order.** Each message row stores the sequence of the event that created it. That sequence is the transcript order.
- **Live overlay.** A message read includes text that is still streaming.
- **Catch-up.** `session.history(after, limit)` returns durable events after a sequence.

Notification order is not guaranteed to match sequence order when two publishers commit close together, the event stream can drop, and applying one durable event twice is not safe (`text.started` would add a second part). The rules below exist for those three facts.

## Rules

### Snapshots carry a watermark

A message page returns `watermark`: the session's latest durable sequence, read in the same transaction as the rows. The page reflects exactly the durable events up to the watermark. Streaming text in the page may be newer; a text part only grows until its `ended` event.

Messages are ordered by their creation sequence, never by ID or timestamp.

### Durable events apply once, in order

The client tracks `applied`, the highest sequence applied without a gap.

| Incoming sequence | Action                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<= applied`      | Drop.                                                                                                                                |
| `applied + 1`     | Apply with the kernel's own event-to-message reducer, advance, then drain any buffered successors.                                   |
| `> applied + 1`   | Buffer. If the gap is still open after a short wait, read `session.history(after = applied)`. Re-read a snapshot only if that fails. |

Events the client does not render (host diagnostics) still advance `applied`.

### Opening and paging

The event stream is always open, so events that arrive while a snapshot is in flight are buffered, not lost. After the snapshot lands, `applied` becomes its watermark, buffered events at or below it are dropped and the rest apply in order.

The client keeps a short tail of recently applied durable events. When an older page arrives with watermark `w`, events from the tail with a sequence above `w` are applied to that page before it is merged. An event that targets a message the client has not loaded is a no-op: when that page is read later its watermark covers the event.

### Live fragments merge by offset, and `ended` wins

For a part with current length `L` and a fragment at offset `o`:

| Case                 | Action                                                             |
| -------------------- | ------------------------------------------------------------------ |
| `o <= L`             | Append the portion of the fragment beyond `L`.                     |
| `o > L`              | Hold the fragment until the gap closes or the part ends.           |
| part not created yet | Hold per part, bounded, until its durable `started` event applies. |
| no offset            | Append.                                                            |

The durable `ended` event replaces the text and clears held fragments. Lost or reordered fragments can therefore only shorten what is shown while streaming.

After a reconnect the client re-reads only the messages that are still streaming.

### Turn ownership

Assistant, shell and synthetic messages record `turn`: the user message they were produced for. The kernel already computes that source when a provider step starts. When it cannot be known (older data, a source that compaction removed), the field is absent and the UI falls back to the nearest preceding user message on the same page.

`turn` is display ownership. It does not give a session drain a durable identity, and it never changes once written.

Shell records and synthetic messages keep their own type in the UI.

### Busy and idle

The kernel publishes a live `session.execution` event when a session's local execution starts and ends, and snapshots report the current value. Because a crashed process never publishes the end, the client also asks `session.active` whenever the event stream reconnects. It does not poll.

### Reconnect

On reconnect, each open session reads `session.history(after = applied)`, checks `session.active` and re-reads streaming messages. It re-reads a snapshot only when catch-up fails or the sequence went backwards.

### Pending inputs

Admitted, promoted and cancelled inputs are durable events and are applied like any other. Snapshots include the current pending list from the same transaction. The client's optimistic copy of a just-sent message is replaced as soon as its admission event applies.

## Invariants

1. While following a session with no stream loss, the client reads no history pages. Request count does not grow with the number of tool calls.
2. No message ID appears twice; no part ID appears twice within a message.
3. At equal watermarks, incrementally built state equals a fresh snapshot. A streaming text part may be a prefix of the other.
4. After an `ended` event, the part equals the event's text.
5. After execution ends with no pending input, the session is idle.
6. A message's `turn` never changes, and the owning user message has a lower sequence.
7. Swapped neighbours, repeated events and a dropped stream followed by reconnect all converge to the same state as in-order delivery.
8. Loading the newest page and paging back to the first message yields the full transcript, regardless of events arriving in between.
9. A rendered row keeps its key for the rest of the turn.

## Compatibility

All changes add fields or events. An older client ignores them. A newer client that receives no `watermark` falls back to re-reading pages. Older messages have no `turn` and are not backfilled.
