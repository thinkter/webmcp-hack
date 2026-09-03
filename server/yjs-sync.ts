/**
 * y-websocket wire protocol message constants and encoders.
 */

import * as Y from 'yjs'
import { Reader, Writer } from './codec'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3

export const SYNC_STEP_1 = 0
export const SYNC_STEP_2 = 1
export const SYNC_UPDATE = 2

export const encodeSync = (step: number, payload: Uint8Array): Uint8Array =>
  new Writer().varUint(MSG_SYNC).varUint(step).varBytes(payload).finish()

export const encodeAwareness = (payload: Uint8Array): Uint8Array =>
  new Writer().varUint(MSG_AWARENESS).varBytes(payload).finish()

export type AwarenessEntry = {
  clientId: number
  clock: number
  json: string
}

export class AwarenessStore {
  /** clientId -> { clock, json } */
  private readonly map = new Map<number, { clock: number; json: string }>()

  apply(entries: AwarenessEntry[]): AwarenessEntry[] {
    const accepted: AwarenessEntry[] = []
    for (const entry of entries) {
      const prev = this.map.get(entry.clientId)
      const removal = entry.json === 'null'
      const fresh =
        prev === undefined ||
        entry.clock > prev.clock ||
        (entry.clock === prev.clock && removal && prev.json !== 'null')

      if (!fresh) continue
      this.map.set(entry.clientId, { clock: entry.clock, json: entry.json })
      accepted.push(entry)
    }
    return accepted
  }

  retract(clientIds: Iterable<number>): AwarenessEntry[] {
    const retracted: AwarenessEntry[] = []
    for (const id of clientIds) {
      const prev = this.map.get(id)
      const clock = (prev?.clock ?? 0) + 1
      this.map.set(id, { clock, json: 'null' })
      retracted.push({ clientId: id, clock, json: 'null' })
    }
    return retracted
  }

  snapshot(): Uint8Array | null {
    const live = [...this.map.entries()].filter(([, entry]) => entry.json !== 'null')
    if (live.length === 0) return null
    const w = new Writer().varUint(live.length)
    for (const [clientId, entry] of live) {
      w.varUint(clientId).varUint(entry.clock).varString(entry.json)
    }
    return encodeAwareness(w.finish())
  }

  encodeBatch(entries: AwarenessEntry[]): Uint8Array | null {
    if (entries.length === 0) return null
    const w = new Writer().varUint(entries.length)
    for (const entry of entries) {
      w.varUint(entry.clientId).varUint(entry.clock).varString(entry.json)
    }
    return encodeAwareness(w.finish())
  }
}

export function parseAwarenessMessage(reader: Reader): AwarenessEntry[] {
  const count = reader.varUint()
  const entries: AwarenessEntry[] = []
  for (let i = 0; i < count; i++) {
    const clientId = reader.varUint()
    const clock = reader.varUint()
    const json = reader.varString()
    entries.push({ clientId, clock, json })
  }
  return entries
}

export function createStep1Message(doc: Y.Doc): Uint8Array {
  return encodeSync(SYNC_STEP_1, Y.encodeStateVector(doc))
}

export function createStep2Message(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  return encodeSync(SYNC_STEP_2, Y.encodeStateAsUpdate(doc, stateVector))
}

export function createUpdateMessage(update: Uint8Array): Uint8Array {
  return encodeSync(SYNC_UPDATE, update)
}
