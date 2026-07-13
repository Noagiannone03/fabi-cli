import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

const emitter = new EventEmitter<{
  event: [GlobalEvent]
}>()

const emit = emitter.emit.bind(emitter)

emitter.emit = ((eventName: string | symbol, ...args: unknown[]) => {
  if (eventName === "event") {
    const event = args[0] as GlobalEvent | undefined
    if (event?.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
  }
  return emit(eventName, ...args)
}) as typeof emitter.emit

export const GlobalBus = emitter
