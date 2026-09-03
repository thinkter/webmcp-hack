/**
 * Presence: who else is in the room, what they have selected, and where their
 * pointer is.
 *
 * Presence is *not* part of the patch. It is ephemeral, high-frequency, and
 * worthless a second after it is published, so it rides on y-protocols
 * awareness (which is broadcast-and-forget, never persisted into the CRDT)
 * rather than on the shared document. Nothing here touches the patch store's
 * history.
 *
 * This module owns no transport. `session.ts` hands it the provider's
 * `Awareness` instance with `attachAwareness()` and takes it back with
 * `detachAwareness()`, so the local selection/cursor can be set at any time —
 * solo, connecting, or online — and is simply not published until there is
 * somewhere to publish it to. No React in here.
 */

import type { Awareness } from 'y-protocols/awareness'
import { LOCAL_ACTOR } from '../graph/store'
import type { Actor } from '../graph/types'

export type Point = { x: number; y: number }

export type Presence = {
  actor: Actor
  selection: string[]
  cursor: { x: number; y: number } | null
  lastSeen: number
}

/**
 * Awareness updates are broadcast to *every* participant, so a raw mousemove
 * stream (which fires at the display refresh rate, 60–144 Hz) would multiply
 * into a socket-saturating fan-out: N peers × 120 Hz × a JSON blob each. 15 Hz
 * is fast enough to read as a live cursor and ~8× cheaper. Publishing is
 * leading-edge plus a guaranteed trailing edge, so the resting position of the
 * pointer is always correct rather than up to 66 ms stale.
 */
const CURSOR_MIN_INTERVAL_MS = 1000 / 15

// ------------------------------------------------------------- identity ----

/** FNV-1a. Small, deterministic, and identical in every tab. */
const hashId = (id: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Stable colour for an actor, derived from its id.
 *
 * Derived rather than assigned because there is no coordinator to hand out
 * colours: every participant must independently arrive at the same colour for
 * the same peer, or the cursor in the canvas and the dot in the history panel
 * would disagree. Multiplying by the golden angle spreads adjacent hash values
 * far apart on the hue circle, so two peers rarely look alike.
 */
export function actorColor(id: string): string {
  const hue = Math.round((hashId(id) * 137.508) % 360)
  return `hsl(${hue}, 82%, 66%)`
}

/**
 * How this client presents itself to everyone else.
 *
 * `LOCAL_ACTOR` is deliberately named "You" and coloured with the editor's
 * accent, which is right on the machine that made the edit and useless
 * everywhere else — a room full of participants all called "You" is not
 * provenance. So the published identity gets a legible name and a hashed
 * colour, while the local store keeps using `LOCAL_ACTOR` for its own history.
 * Net effect: you are always green to yourself, and everyone else has their own
 * stable colour in both your history panel and your canvas.
 *
 * The id is `LOCAL_ACTOR.id`, which is regenerated on every page load. That is
 * intentional: it is the id already stamped on this tab's change records, so
 * remote and local attribution cannot drift apart. A reload is a new
 * participant, which is honest — the undo stack is new too.
 */
export const localPresenceActor: Actor = {
  id: LOCAL_ACTOR.id,
  name: `Editor ${LOCAL_ACTOR.id.slice(-4).toUpperCase()}`,
  kind: LOCAL_ACTOR.kind,
  color: actorColor(LOCAL_ACTOR.id),
}

// ---------------------------------------------------------------- state ----

let awareness: Awareness | null = null

let localSelection: string[] = []
let localCursor: Point | null = null

let peers: Presence[] = []
const listeners = new Set<(peers: Presence[]) => void>()

let lastCursorSentAt = 0
let cursorTimer: ReturnType<typeof setTimeout> | null = null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isPoint = (value: unknown): value is Point =>
  isRecord(value) &&
  typeof value.x === 'number' &&
  typeof value.y === 'number' &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y)

const parseActor = (value: unknown): Actor | null => {
  if (!isRecord(value)) return null
  const { id, name, kind, color } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (kind !== 'human' && kind !== 'agent') return null
  return {
    id,
    name: typeof name === 'string' && name.length > 0 ? name : `Editor ${id.slice(-4).toUpperCase()}`,
    kind,
    // Never trust a peer's colour: deriving it locally guarantees the same peer
    // looks the same in every client, even a malicious or older one.
    color: typeof color === 'string' && color.length > 0 ? color : actorColor(id),
  }
}

const parseSelection = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

const sameSelection = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

// -------------------------------------------------------------- publish ----

const publishState = (): void => {
  awareness?.setLocalState({
    actor: localPresenceActor,
    selection: localSelection,
    cursor: localCursor,
  })
}

const flushCursor = (): void => {
  if (cursorTimer !== null) {
    clearTimeout(cursorTimer)
    cursorTimer = null
  }
  lastCursorSentAt = Date.now()
  awareness?.setLocalStateField('cursor', localCursor)
}

/** Node ids this client currently has selected. Cheap; published immediately. */
export function setLocalSelection(ids: string[]): void {
  if (sameSelection(localSelection, ids)) return
  localSelection = [...ids]
  awareness?.setLocalStateField('selection', localSelection)
}

/**
 * Pointer position in *flow* coordinates (not screen pixels), because every
 * participant has a different pan/zoom and a screen position would land in the
 * wrong place on their canvas. Callers should pass
 * `screenToFlowPosition({ x: event.clientX, y: event.clientY })`.
 */
export function setLocalCursor(point: { x: number; y: number } | null): void {
  localCursor = point === null ? null : { x: point.x, y: point.y }
  if (awareness === null) return

  // A cursor that left the canvas must vanish now, not in 66 ms, otherwise it
  // is left frozen on somebody else's screen.
  if (localCursor === null) {
    flushCursor()
    return
  }

  const wait = CURSOR_MIN_INTERVAL_MS - (Date.now() - lastCursorSentAt)
  if (wait <= 0) {
    flushCursor()
    return
  }
  // The timer publishes whatever `localCursor` holds when it fires, so the last
  // movement of a gesture is always delivered (trailing edge).
  if (cursorTimer === null) cursorTimer = setTimeout(flushCursor, wait)
}

// -------------------------------------------------------------- observe ----

const recompute = (): void => {
  const instance = awareness
  if (instance === null) {
    if (peers.length === 0) return
    peers = []
    notify()
    return
  }

  const next: Presence[] = []
  for (const [clientId, raw] of instance.getStates()) {
    // `raw` is `any` at the library boundary; widen to `unknown` immediately so
    // nothing untyped leaks into the rest of the module.
    const state: unknown = raw
    if (!isRecord(state)) continue
    const actor = parseActor(state.actor)
    if (actor === null) continue
    next.push({
      actor,
      selection: parseSelection(state.selection),
      cursor: isPoint(state.cursor) ? { x: state.cursor.x, y: state.cursor.y } : null,
      // `meta.lastUpdated` is stamped locally when the update was applied, so
      // it is immune to a peer's clock being wrong.
      lastSeen: instance.meta.get(clientId)?.lastUpdated ?? Date.now(),
    })
  }

  // Self first, then stable by name, so a UI list does not reorder itself every
  // time somebody moves their mouse.
  next.sort((a, b) => {
    const selfA = a.actor.id === localPresenceActor.id ? 0 : 1
    const selfB = b.actor.id === localPresenceActor.id ? 0 : 1
    return selfA - selfB || a.actor.name.localeCompare(b.actor.name)
  })

  peers = next
  notify()
}

function notify(): void {
  const snapshot = peers
  for (const listener of [...listeners]) {
    try {
      listener(snapshot)
    } catch (err) {
      console.error('[presence] listener threw:', err)
    }
  }
}

const onAwarenessChange = (): void => {
  recompute()
}

/**
 * Everyone in the room, including yourself (self is always first). Cursors move
 * up to 15×/s, so a consumer that only cares about membership should compare
 * ids rather than re-rendering on every emission.
 */
export function getPresence(): Presence[] {
  return peers
}

export function subscribePresence(listener: (peers: Presence[]) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// --------------------------------------------------------------- wiring ----

/**
 * Binds to a provider's awareness instance and immediately publishes the
 * current local identity, selection, and cursor.
 *
 * Idempotent by way of `detachAwareness()`: a React StrictMode double-mount or
 * a reconnect that hands over a new provider cannot end up with two 'change'
 * subscriptions on the same instance.
 */
export function attachAwareness(instance: Awareness): void {
  if (awareness === instance) {
    publishState()
    return
  }
  detachAwareness()
  awareness = instance
  instance.on('change', onAwarenessChange)
  publishState()
  recompute()
}

/** Stops publishing and clears the peer list. Safe to call when detached. */
export function detachAwareness(): void {
  const instance = awareness
  if (cursorTimer !== null) {
    clearTimeout(cursorTimer)
    cursorTimer = null
  }
  awareness = null
  if (instance !== null) {
    instance.off('change', onAwarenessChange)
    // Retract our state so peers drop this cursor instead of leaving it
    // hanging until awareness times the client out 30 s later.
    instance.setLocalState(null)
  }
  recompute()
}
