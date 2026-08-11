import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

const replayCapacity = 2048

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  readonly #journal: GlobalEvent[] = []

  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    this.#journal.push(event)
    if (this.#journal.length > replayCapacity) this.#journal.splice(0, this.#journal.length - replayCapacity)
    return super.emit(eventName, event)
  }

  replayAfter(id?: string) {
    if (!id) return { events: [] as GlobalEvent[], complete: false }
    const index = this.#journal.findIndex((event) => event.payload?.id === id)
    if (index < 0) return { events: [] as GlobalEvent[], complete: false }
    return { events: this.#journal.slice(index + 1), complete: true }
  }
}

export const GlobalBus = new GlobalBusEmitter()
