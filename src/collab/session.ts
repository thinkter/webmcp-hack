/**
 * Multiplayer transport and CRDT binding.
 *
 * ---------------------------------------------------------------------------
 * THE SYNC MODEL, AND WHY
 * ---------------------------------------------------------------------------
 * The patch store is mutation-based with attributed history: every edit is a
 * `ChangeRecord` holding reversible `Mutation`s. That is the right model for
 * "undo everything the agent did in the last two minutes", and it is *not* a
 * CRDT — two peers replaying each other's mutation logs in different orders can
 * diverge. So the shared document is the CRDT, and the mutation log is a
 * translation layer on top of it:
 *
 *   Y.Map  'nodes'  id -> plain-JSON node entry   (last-write-wins per node)
 *   Y.Map  'edges'  id -> plain-JSON edge entry   (last-write-wins per edge)
 *   Y.Map  'meta'   name | resolution | seeded
 *   Y.Array 'log'   ChangeRecord provenance, capped
 *
 * Keying by id is the load-bearing decision. It makes every write idempotent,
 * which is what makes reconnection safe: re-merging a doc we already merged
 * cannot duplicate a node, because `nodes.set('glitch-1', …)` twice is one
 * entry, whereas a Y.Array of nodes would end up with two.
 *
 * Parameters are stored as a plain JSON blob inside the node entry rather than
 * as nested Y.Maps. Nesting would buy per-parameter concurrent merging, at the
 * cost of one CRDT type per parameter per node (hundreds of them), a much
 * larger document, and a far more delicate diff. Parameter values are tiny,
 * scalar, and rewritten wholesale by the UI anyway; if two people drag the same
 * slider at the same moment, "one of the two values wins" is the *correct*
 * answer, not a merge. Last-write-wins per node is dramatically simpler and
 * behaves identically for every realistic edit. The trade-off is real and
 * documented: two peers editing two different parameters of the *same* node
 * within the same network round trip will keep only the later node entry.
 *
 * ---------------------------------------------------------------------------
 * ECHO PREVENTION (the important part)
 * ---------------------------------------------------------------------------
 * The loop store -> Yjs -> store -> Yjs is broken twice, independently:
 *
 * 1. Transaction origin. Every write this client makes happens inside
 *    `doc.transact(fn, LOCAL_ORIGIN)`. The map observers receive the
 *    transaction and return immediately when `transaction.origin ===
 *    LOCAL_ORIGIN`, so our own writes never come back as "remote changes". Only
 *    transactions from somewhere else (the WebsocketProvider applying a peer's
 *    update, or the cross-tab BroadcastChannel) get reconciled. `LOCAL_ORIGIN`
 *    is a module-private symbol, so nothing else can forge it.
 * 2. `applyRemote`. Remote changes are applied through the store's
 *    `applyRemote`, which deliberately does not run `commit`, so it fires no
 *    `onCommit` listener and therefore cannot generate a write back into Yjs.
 *
 * Either mechanism alone would stop the echo; both are in place because an
 * infinite edit loop between two browsers is the single worst failure mode this
 * layer can have, and the cost of the redundancy is two lines.
 *
 * There is also a useful invariant: local commits write to Yjs *synchronously*
 * inside `onCommit`, so the store and the Y doc are normally in lockstep. Any
 * divergence observed while reconciling is therefore remote in origin, which is
 * what lets the reconciler use a plain diff instead of tracking causality.
 * `pushLocalDrift()` (see below) is what keeps that invariant true for the store
 * paths that bypass `commit`.
 */

import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { operatorMap } from '../engine/ops'
import { LOCAL_ACTOR, usePatchStore } from '../graph/store'
import type {
  Actor,
  ChangeKind,
  ChangeRecord,
  EdgeData,
  Mutation,
  NodeData,
  ParamValue,
  PatchEdge,
  PatchNode,
  Resolution,
} from '../graph/types'
import { generateRoomCode, parseRoomParams } from '../remote/links'
import { resolveServerUrl } from '../remote/signal'
import {
  attachAwareness,
  detachAwareness,
  localPresenceActor,
  setLocalSelection,
  subscribePresence,
  type Presence,
} from './presence'

// ------------------------------------------------------------- constants ----

const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'
const META_KEY = 'meta'
const LOG_KEY = 'log'

const SEEDED_FIELD = 'seeded'
const NAME_FIELD = 'name'
const RESOLUTION_FIELD = 'resolution'

/** Provenance is nice to have, not the document. 240 entries is plenty. */
const LOG_CAP = 240

/**
 * How long uncommitted local state (a drag in progress, a rename) may lag the
 * shared doc. Long enough to coalesce a drag into a handful of updates, short
 * enough that a collaborator sees the node move rather than teleport.
 */
const DRIFT_INTERVAL_MS = 120

const ROOM_STORAGE_KEY = 'signal-yard:room'

/** Private to this module, so no other code can produce a transaction that
 * looks local to us. */
const LOCAL_ORIGIN = Symbol('signal-yard/local')

const uid = (prefix: string): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`

// ------------------------------------------------------- document shapes ----

type Point = { x: number; y: number }

/**
 * What actually goes into the Y maps: a node stripped of everything React Flow
 * owns. `selected`, `dragging`, and `measured` are per-viewer UI state — sharing
 * them would make one person's click move another person's selection, and would
 * make the diff below fire constantly. Selection travels through awareness
 * instead (see `presence.ts`).
 */
type NodeEntry = {
  id: string
  type: 'operator'
  position: Point
  data: NodeData
}

type EdgeEntry = {
  id: string
  source: string
  target: string
  sourceHandle: string | null
  targetHandle: string | null
  data: EdgeData
}

type LogEntry = {
  id: string
  at: number
  actor: Actor
  kind: ChangeKind
  label: string
  targets: string[]
}

// ------------------------------------------------------------- validation ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isPoint = (value: unknown): value is Point =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)

const isParamValue = (value: unknown): value is ParamValue => {
  if (typeof value === 'boolean' || typeof value === 'string') return true
  if (isFiniteNumber(value)) return true
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber)
}

const CHANGE_KINDS: ReadonlySet<string> = new Set<ChangeKind>([
  'create',
  'delete',
  'connect',
  'disconnect',
  'parameter',
  'layout',
  'document',
  'revert',
])

/**
 * Everything read out of the CRDT is validated. The doc is written by other
 * browsers, possibly running an older build of this app, and a malformed entry
 * must degrade to "ignore that node" rather than crash the renderer.
 */
const sanitizeParams = (value: unknown): Record<string, ParamValue> => {
  const params: Record<string, ParamValue> = {}
  if (!isRecord(value)) return params
  for (const [key, raw] of Object.entries(value)) {
    if (isParamValue(raw)) params[key] = Array.isArray(raw) ? [raw[0], raw[1], raw[2], raw[3]] : raw
  }
  return params
}

const parseNodeEntry = (raw: unknown): NodeEntry | null => {
  if (!isRecord(raw)) return null
  const { id, position, data } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  if (!isPoint(position) || !isRecord(data)) return null
  if (typeof data.op !== 'string' || data.op.length === 0) return null

  const entry: NodeData = {
    op: data.op,
    name: typeof data.name === 'string' ? data.name : data.op,
    enabled: data.enabled !== false,
    bypass: data.bypass === true,
    params: sanitizeParams(data.params),
  }
  if (typeof data.comment === 'string') entry.comment = data.comment

  return { id, type: 'operator', position: { x: position.x, y: position.y }, data: entry }
}

const parseEdgeEntry = (raw: unknown): EdgeEntry | null => {
  if (!isRecord(raw)) return null
  const { id, source, target, sourceHandle, targetHandle, data } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof source !== 'string' || typeof target !== 'string') return null
  const kind = isRecord(data) && data.kind === 'number' ? 'number' : 'texture'
  return {
    id,
    source,
    target,
    sourceHandle: typeof sourceHandle === 'string' ? sourceHandle : null,
    targetHandle: typeof targetHandle === 'string' ? targetHandle : null,
    data: { kind },
  }
}

const parseResolution = (raw: unknown): Resolution | null => {
  if (!isRecord(raw)) return null
  const { width, height } = raw
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width < 16 || height < 16) return null
  return { width: Math.round(width), height: Math.round(height) }
}

const parseActor = (raw: unknown): Actor | null => {
  if (!isRecord(raw)) return null
  const { id, name, kind, color } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  if (kind !== 'human' && kind !== 'agent') return null
  return {
    id,
    name: typeof name === 'string' && name.length > 0 ? name : id,
    kind,
    color: typeof color === 'string' && color.length > 0 ? color : '#8899aa',
  }
}

const parseLogEntry = (raw: unknown): LogEntry | null => {
  if (!isRecord(raw)) return null
  const { id, at, kind, label, targets } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  const actor = parseActor(raw.actor)
  if (actor === null) return null
  if (typeof kind !== 'string' || !CHANGE_KINDS.has(kind)) return null
  return {
    id,
    at: isFiniteNumber(at) ? at : Date.now(),
    actor,
    kind: kind as ChangeKind,
    label: typeof label === 'string' ? label : 'Remote change',
    targets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : [],
  }
}

// ----------------------------------------------------------- conversion ----

const sanitizeNode = (node: PatchNode): NodeEntry => {
  const data: NodeData = {
    op: node.data.op,
    name: node.data.name,
    enabled: node.data.enabled !== false,
    bypass: node.data.bypass === true,
    params: sanitizeParams(node.data.params),
  }
  if (typeof node.data.comment === 'string') data.comment = node.data.comment
  return {
    id: node.id,
    type: 'operator',
    position: { x: node.position.x, y: node.position.y },
    data,
  }
}

const sanitizeEdge = (edge: PatchEdge): EdgeEntry => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  sourceHandle: edge.sourceHandle ?? null,
  targetHandle: edge.targetHandle ?? null,
  data: { kind: edge.data?.kind === 'number' ? 'number' : 'texture' },
})

const toPatchNode = (entry: NodeEntry): PatchNode => ({
  id: entry.id,
  type: 'operator',
  position: { x: entry.position.x, y: entry.position.y },
  data: structuredClone(entry.data),
})

const toPatchEdge = (entry: EdgeEntry): PatchEdge => ({
  id: entry.id,
  source: entry.source,
  target: entry.target,
  sourceHandle: entry.sourceHandle,
  targetHandle: entry.targetHandle,
  data: { kind: entry.data.kind },
})

/** Structural equality for the JSON subset that lives in the document. */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (!isRecord(a) || !isRecord(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every((key) => key in b && deepEqual(a[key], b[key]))
}

// ---------------------------------------------------------- public state ----

export type SessionStatus = 'solo' | 'connecting' | 'online' | 'error'

export type SessionState = {
  room: string
  status: SessionStatus
  shared: boolean
  peers: number
  error: string | null
  peerList: Presence[]
  adoptedRemote: boolean
}

const normalizeRoom = (value: string): string => {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : generateRoomCode()
}

/**
 * The room code exists before anyone joins, because the Session panel prints QR
 * codes that must point somewhere. Precedence: an invite link in the URL, then
 * the code this browser used last (so a refresh keeps the same room), then a
 * fresh one.
 *
 * A URL-supplied code is *not* persisted here — only actually joining persists
 * it, so glancing at somebody's invite link does not silently replace your own
 * room code.
 */
const initialRoom = (): string => {
  const fromUrl = parseRoomParams().room
  if (fromUrl !== null) return normalizeRoom(fromUrl)
  try {
    const stored = localStorage.getItem(ROOM_STORAGE_KEY)
    if (stored !== null && stored.length > 0) return normalizeRoom(stored)
  } catch {
    // Private-mode Safari throws on localStorage access; a fresh code is fine.
  }
  const generated = generateRoomCode()
  rememberRoom(generated)
  return generated
}

function rememberRoom(code: string): void {
  try {
    localStorage.setItem(ROOM_STORAGE_KEY, code)
  } catch {
    // Not being able to remember the room is not worth surfacing.
  }
}

/** Keep the address bar in lockstep with the connected room so the current URL is always an invite. */
function syncRoomUrl(code: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (code && code.length > 0) url.searchParams.set('room', code)
  else url.searchParams.delete('room')
  const next = `${url.pathname}${url.search}${url.hash}`
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return
  window.history.replaceState({}, '', next)
}

/**
 * Updates the pending lobby code without connecting.
 *
 * Ignored while a socket is open: the connected room only changes through
 * `joinSession`, so QR codes and invite links never point at a room we left.
 */
export function setRoomCode(next: string): void {
  if (provider !== null) return
  const cleaned = next
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 120)
  if (cleaned.length === 0 || cleaned === room) return
  room = cleaned
  rememberRoom(room)
  publish()
}

/** Mints a fresh lobby code. Switches immediately if already online. */
export function mintRoom(): string {
  const code = generateRoomCode()
  if (provider !== null) {
    joinSession(code)
    return code
  }
  room = code
  rememberRoom(room)
  publish()
  return code
}

// -------------------------------------------------------- module singleton ----

let room = initialRoom()
let socketStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected'
let hasEverConnected = false
let errorMessage: string | null = null
let fatal = false
let shared = false
let adoptedRemote = false

let doc: Y.Doc | null = null
let provider: WebsocketProvider | null = null
/** Latched for the lifetime of one join, so a reconnect never re-seeds. */
let bootstrapped = false

let nodesMap: Y.Map<unknown> | null = null
let edgesMap: Y.Map<unknown> | null = null
let metaMap: Y.Map<unknown> | null = null
let logArray: Y.Array<unknown> | null = null

const teardown: Array<() => void> = []
let driftTimer: ReturnType<typeof setTimeout> | null = null
let reconcileQueued = false

/**
 * THE BASELINE: the last state this client and the shared document agreed on.
 *
 * Without it, neither direction of sync can tell *which side moved*. If the
 * store says a node's `amount` is 0.5 and the document says 0.9, that is either
 * a remote edit we have not applied yet or a local edit we have not published
 * yet, and guessing wrong loses somebody's work — guess "local" and every
 * remote parameter change is silently overwritten; guess "remote" and an
 * in-progress drag snaps out from under the pointer.
 *
 * With a baseline it is a three-way merge and there is no guessing: whichever
 * side differs from the baseline is the side that changed. The baseline is
 * re-captured from the document after every write we make and after every
 * remote change we apply.
 */
let baseNodes = new Map<string, NodeEntry>()
let baseEdges = new Map<string, EdgeEntry>()
let baseName: string | null = null
let baseResolution: Resolution | null = null

/** Ids of log entries already accounted for, so provenance is never doubled. */
const seenLogIds = new Set<string>()

let peerList: Presence[] = []
let peerSignature = ''

const listeners = new Set<() => void>()

let snapshot: SessionState = {
  room,
  status: 'solo',
  shared: false,
  peers: 1,
  error: null,
  peerList: [],
  adoptedRemote: false,
}

const computeStatus = (): SessionStatus => {
  if (provider === null) return 'solo'
  if (fatal) return 'error'
  // A first connection that never succeeds is an error worth showing; a drop
  // after a successful connection is just a retry in progress.
  if (errorMessage !== null && !hasEverConnected) return 'error'
  if (socketStatus === 'connected' && shared) return 'online'
  return 'connecting'
}

/** Rebuilds the immutable snapshot, but only when something actually changed —
 * `useSyncExternalStore` requires a referentially stable value. */
function publish(): void {
  const next: SessionState = {
    room,
    status: computeStatus(),
    shared,
    peers: provider === null ? 1 : Math.max(1, peerList.length),
    error: errorMessage,
    peerList,
    adoptedRemote,
  }
  if (
    next.room === snapshot.room &&
    next.status === snapshot.status &&
    next.shared === snapshot.shared &&
    next.peers === snapshot.peers &&
    next.error === snapshot.error &&
    next.peerList === snapshot.peerList &&
    next.adoptedRemote === snapshot.adoptedRemote
  ) {
    return
  }
  snapshot = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (err) {
      console.error('[session] listener threw:', err)
    }
  }
}

export function getSessionState(): SessionState {
  return snapshot
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Cursor motion arrives up to 15×/s per peer. Folding that into the session
 * snapshot would re-render every consumer of `useSession()` — including the
 * whole React Flow canvas — at 15 Hz for as long as somebody wiggles a mouse.
 * So the snapshot's `peerList` is refreshed only when the *structure* of the
 * room changes (who is here, what they have selected, whether their pointer is
 * on the canvas at all). A cursor overlay should subscribe to
 * `subscribePresence` directly and re-render only itself.
 */
const presenceSignature = (list: Presence[]): string =>
  list
    .map((peer) => `${peer.actor.id}~${peer.actor.name}~${peer.selection.join('|')}~${peer.cursor === null ? '0' : '1'}`)
    .join(',')

// ------------------------------------------------------- local -> remote ----

const containers = (): {
  doc: Y.Doc
  nodes: Y.Map<unknown>
  edges: Y.Map<unknown>
  meta: Y.Map<unknown>
  log: Y.Array<unknown>
} | null => {
  if (doc === null || nodesMap === null || edgesMap === null || metaMap === null || logArray === null) {
    return null
  }
  return { doc, nodes: nodesMap, edges: edgesMap, meta: metaMap, log: logArray }
}

/**
 * The identity other participants see for a record made on this machine.
 *
 * Local human edits are published as this client's presence actor (see
 * `presence.ts`). Agent edits keep the agent's own colour and kind — an agent
 * should look like an agent in everyone's history panel — but get qualified
 * with the operator's name, because "Agent" alone is ambiguous once two people
 * each have one.
 */
const outboundActor = (actor: Actor): Actor => {
  if (actor.id === LOCAL_ACTOR.id) return localPresenceActor
  if (actor.kind === 'agent') {
    return {
      ...actor,
      id: `${localPresenceActor.id}:${actor.id}`,
      name: `${actor.name} · ${localPresenceActor.name}`,
    }
  }
  return actor
}

type Bundle = NonNullable<ReturnType<typeof containers>>

const captureBaseline = (bundle: Bundle): void => {
  const nodes = new Map<string, NodeEntry>()
  for (const [id, raw] of bundle.nodes.entries()) {
    const entry = parseNodeEntry(raw)
    if (entry !== null) nodes.set(id, entry)
  }
  const edges = new Map<string, EdgeEntry>()
  for (const [id, raw] of bundle.edges.entries()) {
    const entry = parseEdgeEntry(raw)
    if (entry !== null) edges.set(id, entry)
  }
  baseNodes = nodes
  baseEdges = edges
  const name = bundle.meta.get(NAME_FIELD)
  baseName = typeof name === 'string' ? name : null
  baseResolution = parseResolution(bundle.meta.get(RESOLUTION_FIELD))
}

const appendLog = (bundle: Bundle, record: ChangeRecord): void => {
  const entry: LogEntry = {
    id: record.id,
    at: record.at,
    actor: outboundActor(record.actor),
    kind: record.kind,
    label: record.label,
    targets: [...record.targets],
  }
  // Marked as seen before it is written, so the observer that fires for our own
  // transaction can never re-import it as remote provenance.
  seenLogIds.add(entry.id)
  bundle.log.push([entry])
  const overflow = bundle.log.length - LOG_CAP
  if (overflow > 0) bundle.log.delete(0, overflow)
}

/** Rewrites one node's entry from current store state (last-write-wins). */
const writeNode = (bundle: Bundle, nodeId: string): void => {
  const node = usePatchStore.getState().nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined) return
  bundle.nodes.set(nodeId, sanitizeNode(node))
}

const pushMutation = (bundle: Bundle, mutation: Mutation): void => {
  switch (mutation.type) {
    case 'addNode':
      bundle.nodes.set(mutation.node.id, sanitizeNode(mutation.node))
      break
    case 'removeNode':
      bundle.nodes.delete(mutation.node.id)
      // The store drops dangling edges implicitly; mirror that here so a peer
      // cannot end up with an edge pointing at a node that no longer exists.
      // Deletions normally arrive as explicit `removeEdge` mutations too, and
      // deleting an absent key is a no-op, so this is belt and braces.
      for (const [id, raw] of [...bundle.edges.entries()]) {
        const edge = parseEdgeEntry(raw)
        if (edge === null) continue
        if (edge.source === mutation.node.id || edge.target === mutation.node.id) bundle.edges.delete(id)
      }
      break
    case 'addEdge':
      bundle.edges.set(mutation.edge.id, sanitizeEdge(mutation.edge))
      break
    case 'removeEdge':
      bundle.edges.delete(mutation.edge.id)
      break
    case 'setParam':
    case 'setField':
    case 'move':
      // Targeted, but node-granular: one parameter change rewrites that node's
      // entry and nothing else.
      writeNode(bundle, mutation.nodeId)
      break
    case 'replaceAll': {
      const nodes = mutation.after.nodes
      const edges = mutation.after.edges
      const keepNodes = new Set(nodes.map((node) => node.id))
      const keepEdges = new Set(edges.map((edge) => edge.id))
      for (const id of [...bundle.nodes.keys()]) if (!keepNodes.has(id)) bundle.nodes.delete(id)
      for (const id of [...bundle.edges.keys()]) if (!keepEdges.has(id)) bundle.edges.delete(id)
      for (const node of nodes) bundle.nodes.set(node.id, sanitizeNode(node))
      for (const edge of edges) bundle.edges.set(edge.id, sanitizeEdge(edge))
      break
    }
    case 'setResolution':
      bundle.meta.set(RESOLUTION_FIELD, { width: mutation.after.width, height: mutation.after.height })
      break
    case 'setName':
      bundle.meta.set(NAME_FIELD, mutation.after)
      break
  }
}

/**
 * Local commit -> Yjs. One transaction per `ChangeRecord`, tagged with
 * `LOCAL_ORIGIN`, so peers receive the whole record as a single atomic update
 * and our own observers ignore it.
 */
const pushRecord = (record: ChangeRecord): void => {
  const bundle = containers()
  if (bundle === null || !shared) return
  bundle.doc.transact(() => {
    for (const mutation of record.mutations) pushMutation(bundle, mutation)
    appendLog(bundle, record)
  }, LOCAL_ORIGIN)
  // We and the document now agree on everything this record touched.
  captureBaseline(bundle)
}

/**
 * Repairs divergence created by store paths that never reach `commit`:
 *
 *  - dragging a node updates `nodes` on every mouse move via
 *    `onNodesChange`, and `moveNode` merges consecutive drags of the same node
 *    into the previous history entry with a bare `set()` — no commit, so no
 *    `onCommit`, so the final resting position of a drag would never be
 *    published;
 *  - `setName` commits a mutation, but a rename in progress can still lag
 *    the shared doc until the next drift tick if it arrived some other way.
 *
 * Two rules keep it from doing damage:
 *
 * 1. It compares the store against the *baseline*, not against the document, so
 *    it only publishes values the local user actually changed. A pending remote
 *    change also makes store and document disagree, and pushing over it would
 *    make remote edits impossible to land.
 * 2. It only updates keys that already exist in the document, and never creates
 *    or deletes. Creation and deletion always go through `commit`, and a sweep
 *    that could create would resurrect a node a peer had just deleted (our
 *    store still holds it until the next reconcile).
 */
const pushLocalDrift = (): void => {
  const bundle = containers()
  if (bundle === null || !shared) return
  const state = usePatchStore.getState()

  const pending: Array<() => void> = []
  for (const node of state.nodes) {
    const base = baseNodes.get(node.id)
    if (base === undefined || !bundle.nodes.has(node.id)) continue
    const entry = sanitizeNode(node)
    if (deepEqual(entry, base)) continue
    pending.push(() => bundle.nodes.set(node.id, entry))
  }
  for (const edge of state.edges) {
    const base = baseEdges.get(edge.id)
    if (base === undefined || !bundle.edges.has(edge.id)) continue
    const entry = sanitizeEdge(edge)
    if (deepEqual(entry, base)) continue
    pending.push(() => bundle.edges.set(edge.id, entry))
  }
  if (baseName !== null && state.name !== baseName) {
    const name = state.name
    pending.push(() => bundle.meta.set(NAME_FIELD, name))
  }

  if (pending.length === 0) return
  bundle.doc.transact(() => {
    for (const write of pending) write()
  }, LOCAL_ORIGIN)
  captureBaseline(bundle)
}

const scheduleDrift = (): void => {
  if (driftTimer !== null || !shared) return
  driftTimer = setTimeout(() => {
    driftTimer = null
    pushLocalDrift()
  }, DRIFT_INTERVAL_MS)
}

// ------------------------------------------------------- remote -> local ----

const KIND_PRIORITY: Array<[Mutation['type'], ChangeKind]> = [
  ['replaceAll', 'document'],
  ['removeNode', 'delete'],
  ['addNode', 'create'],
  ['addEdge', 'connect'],
  ['removeEdge', 'disconnect'],
  ['setParam', 'parameter'],
  ['setField', 'parameter'],
  ['move', 'layout'],
  ['setResolution', 'document'],
  ['setName', 'document'],
]

const kindForMutations = (mutations: Mutation[]): ChangeKind => {
  for (const [type, kind] of KIND_PRIORITY) {
    if (mutations.some((mutation) => mutation.type === type)) return kind
  }
  return 'document'
}

const describeMutations = (mutations: Mutation[], nodeName: (id: string) => string): string => {
  const first = mutations[0]
  if (first === undefined) return 'Remote change'
  const extra = mutations.length > 1 ? ` (+${mutations.length - 1} more)` : ''
  switch (first.type) {
    case 'addNode':
      return `Added ${first.node.data.name}${extra}`
    case 'removeNode':
      return `Removed ${first.node.data.name}${extra}`
    case 'addEdge':
      return `Connected ${nodeName(first.edge.source)} → ${nodeName(first.edge.target)}${extra}`
    case 'removeEdge':
      return `Disconnected ${nodeName(first.edge.source)} → ${nodeName(first.edge.target)}${extra}`
    case 'setParam':
      return `Changed ${first.key} on ${nodeName(first.nodeId)}${extra}`
    case 'setField':
      return `Changed ${first.key} on ${nodeName(first.nodeId)}${extra}`
    case 'move':
      return `Moved ${nodeName(first.nodeId)}${extra}`
    case 'replaceAll':
      return `Replaced the patch${extra}`
    case 'setResolution':
      return `Resolution ${first.after.width} × ${first.after.height}${extra}`
    case 'setName':
      return `Renamed patch to "${first.after}"${extra}`
  }
}

/**
 * Fallback attribution when a peer changed the document without writing
 * provenance (an older build, or a change that arrived split across updates).
 */
const unknownPeerActor = (): Actor => {
  const other = peerList.find((peer) => peer.actor.id !== localPresenceActor.id)
  return other?.actor ?? { id: 'peer', name: 'Collaborator', kind: 'human', color: '#8fa4c0' }
}

const FIELD_KEYS: Array<'name' | 'enabled' | 'bypass' | 'comment'> = [
  'name',
  'enabled',
  'bypass',
  'comment',
]

/**
 * Granular mutations that bring one node up to date with the document.
 *
 * Field-level rather than "replace the whole node", for three reasons: the
 * history entry reads like an edit instead of a rewrite, the node keeps its
 * place in the array (so render order does not shuffle on every parameter
 * tweak), and — most importantly — a field the remote side did not touch is
 * left alone, so a drag in progress survives somebody else changing a parameter
 * of the same node.
 *
 * `base` is the last agreed value: a field is only applied when *remote* moved
 * away from it. `before` is taken from the local node so the synthesised record
 * inverts back to what this user was actually looking at.
 */
const diffNodeInto = (
  local: PatchNode,
  remote: NodeEntry,
  base: NodeEntry | undefined,
  out: Mutation[],
): void => {
  if (base === undefined || base.data.op !== remote.data.op) {
    // No baseline (or the operator itself changed, which the editor cannot do):
    // the document wins wholesale.
    if (!deepEqual(sanitizeNode(local), remote)) {
      out.push({ type: 'addNode', node: toPatchNode(remote) })
    }
    return
  }

  const movedRemotely =
    remote.position.x !== base.position.x || remote.position.y !== base.position.y
  const differsLocally =
    remote.position.x !== local.position.x || remote.position.y !== local.position.y
  if (movedRemotely && differsLocally) {
    out.push({
      type: 'move',
      nodeId: local.id,
      before: { x: local.position.x, y: local.position.y },
      after: { x: remote.position.x, y: remote.position.y },
    })
  }

  for (const key of FIELD_KEYS) {
    const after = remote.data[key]
    if (deepEqual(after, base.data[key])) continue
    if (deepEqual(after, local.data[key])) continue
    out.push({ type: 'setField', nodeId: local.id, key, before: local.data[key], after })
  }

  const keys = new Set([...Object.keys(base.data.params), ...Object.keys(remote.data.params)])
  for (const key of keys) {
    const after = remote.data.params[key]
    if (deepEqual(after, base.data.params[key])) continue
    if (deepEqual(after, local.data.params[key])) continue
    out.push({ type: 'setParam', nodeId: local.id, key, before: local.data.params[key], after })
  }
}

/**
 * Diffs the shared document against the store and applies the difference as one
 * synthesised `ChangeRecord` per remote provenance entry.
 *
 * Runs once per task rather than once per map event: a single remote update
 * usually touches `nodes`, `edges`, and `log`, and diffing after all of them
 * have landed means one store update and one history entry instead of three.
 *
 * Structural presence (does this id exist?) is taken from the document, which
 * is the authority: adds and removes always go through `commit`, which writes
 * to the document synchronously, so a node in the store but not in the document
 * really was deleted by someone else. Content changes go through the baseline,
 * so uncommitted local state is not mistaken for a remote edit.
 */
const reconcile = (): void => {
  reconcileQueued = false
  const bundle = containers()
  if (bundle === null || !shared) return

  const state = usePatchStore.getState()
  const localNodes = new Map(state.nodes.map((node) => [node.id, node]))
  const localEdges = new Map(state.edges.map((edge) => [edge.id, edge]))

  const remoteNodes = new Map<string, NodeEntry>()
  for (const [id, raw] of bundle.nodes.entries()) {
    const entry = parseNodeEntry(raw)
    if (entry === null) continue
    if (!operatorMap.has(entry.data.op)) {
      // A peer on a newer build added an operator this build cannot render.
      // Skipping it keeps the rest of the patch usable.
      continue
    }
    remoteNodes.set(id, entry)
  }

  const remoteEdges = new Map<string, EdgeEntry>()
  for (const [id, raw] of bundle.edges.entries()) {
    const entry = parseEdgeEntry(raw)
    if (entry === null) continue
    if (!remoteNodes.has(entry.source) || !remoteNodes.has(entry.target)) continue
    remoteEdges.set(id, entry)
  }

  const removedNodes: Mutation[] = []
  const removedEdges: Mutation[] = []
  const upsertNodes: Mutation[] = []
  const upsertEdges: Mutation[] = []
  const targets = new Set<string>()

  for (const [id, edge] of localEdges) {
    if (remoteEdges.has(id)) continue
    removedEdges.push({ type: 'removeEdge', edge: structuredClone(edge) })
  }
  for (const [id, node] of localNodes) {
    if (remoteNodes.has(id)) continue
    removedNodes.push({ type: 'removeNode', node: structuredClone(node) })
    targets.add(id)
  }
  for (const [id, entry] of remoteNodes) {
    const local = localNodes.get(id)
    if (local === undefined) {
      upsertNodes.push({ type: 'addNode', node: toPatchNode(entry) })
      targets.add(id)
      continue
    }
    const before = upsertNodes.length
    diffNodeInto(local, entry, baseNodes.get(id), upsertNodes)
    if (upsertNodes.length !== before) targets.add(id)
  }
  for (const [id, entry] of remoteEdges) {
    const local = localEdges.get(id)
    if (local === undefined) {
      upsertEdges.push({ type: 'addEdge', edge: toPatchEdge(entry) })
      continue
    }
    // An edge only changes when it is rewired, which the editor does by
    // deleting and recreating; compare against the baseline so a local rewire
    // waiting to be published is not undone here.
    const base = baseEdges.get(id)
    if (base !== undefined && deepEqual(entry, base)) continue
    if (deepEqual(sanitizeEdge(local), entry)) continue
    removedEdges.push({ type: 'removeEdge', edge: structuredClone(local) })
    upsertEdges.push({ type: 'addEdge', edge: toPatchEdge(entry) })
  }

  const mutations: Mutation[] = [...removedEdges, ...removedNodes, ...upsertNodes, ...upsertEdges]

  const remoteResolution = parseResolution(bundle.meta.get(RESOLUTION_FIELD))
  if (
    remoteResolution !== null &&
    !deepEqual(remoteResolution, baseResolution) &&
    (remoteResolution.width !== state.resolution.width ||
      remoteResolution.height !== state.resolution.height)
  ) {
    mutations.push({ type: 'setResolution', before: state.resolution, after: remoteResolution })
  }

  const incomingName = bundle.meta.get(NAME_FIELD)
  if (
    typeof incomingName === 'string' &&
    incomingName.length > 0 &&
    incomingName !== baseName &&
    incomingName !== state.name
  ) {
    mutations.push({ type: 'setName', before: state.name, after: incomingName })
  }

  // Provenance written by peers in the same transaction as the changes above.
  const fresh: LogEntry[] = []
  for (const raw of bundle.log.toArray()) {
    const entry = parseLogEntry(raw)
    if (entry === null || seenLogIds.has(entry.id)) continue
    seenLogIds.add(entry.id)
    fresh.push(entry)
  }
  if (seenLogIds.size > LOG_CAP * 8) {
    // Keep the set from growing without bound over a long session: anything no
    // longer in the (capped) log can never be offered to us again.
    const live = new Set<string>()
    for (const raw of bundle.log.toArray()) {
      const entry = parseLogEntry(raw)
      if (entry !== null) live.add(entry.id)
    }
    seenLogIds.clear()
    for (const id of live) seenLogIds.add(id)
  }

  const nodeName = (id: string): string =>
    remoteNodes.get(id)?.data.name ?? localNodes.get(id)?.data.name ?? id

  // Everything but the last provenance entry is recorded on its own, so the
  // history reads "Agent added Bloom / Agent connected …" rather than collapsing
  // several peers' work into one line.
  for (const entry of fresh.slice(0, -1)) {
    state.applyRemote({ ...entry, mutations: [] })
  }

  const last = fresh.at(-1)
  if (mutations.length > 0) {
    state.applyRemote({
      id: last?.id ?? uid('rmt'),
      at: last?.at ?? Date.now(),
      actor: last?.actor ?? unknownPeerActor(),
      kind: last?.kind ?? kindForMutations(mutations),
      label: last?.label ?? describeMutations(mutations, nodeName),
      targets: last !== undefined && last.targets.length > 0 ? last.targets : [...targets],
      mutations,
    })
  } else if (last !== undefined) {
    state.applyRemote({ ...last, mutations: [] })
  }

  const remoteName = bundle.meta.get(NAME_FIELD)
  if (
    typeof remoteName === 'string' &&
    remoteName.length > 0 &&
    remoteName !== baseName &&
    remoteName !== usePatchStore.getState().name
  ) {
    // applyRemote already applied the name when it was included in `mutations`.
    // This path is only a fallback; passing a session actor keeps the rename
    // out of the local human undo identity if it does commit.
    state.setName(remoteName, { id: 'session', name: 'Collab', kind: 'human', color: '#69b7ff' })
  }

  // A node someone else deleted must not stay in our selection, or the
  // inspector points at nothing.
  if (removedNodes.length > 0) {
    const gone = new Set(
      removedNodes.flatMap((mutation) => (mutation.type === 'removeNode' ? [mutation.node.id] : [])),
    )
    const kept = state.selectedNodeIds.filter((id) => !gone.has(id))
    if (kept.length !== state.selectedNodeIds.length) state.select(kept)
  }

  // The store now matches the document for everything the document changed;
  // anything still different is local and uncommitted, and `pushLocalDrift`
  // will publish it.
  captureBaseline(bundle)
}

const scheduleReconcile = (): void => {
  if (reconcileQueued) return
  reconcileQueued = true
  queueMicrotask(reconcile)
}

const observeRemote = (event: { transaction: Y.Transaction }): void => {
  // THE echo guard: our own writes carry `LOCAL_ORIGIN` and stop here.
  if (event.transaction.origin === LOCAL_ORIGIN) return
  scheduleReconcile()
}

// ---------------------------------------------------------- first join ----

/**
 * Seeds an empty room from the local patch.
 *
 * `seeded` is written in the same transaction as the content, so the flag and
 * the patch can never be observed apart.
 */
const seedFromLocal = (bundle: Bundle): void => {
  const document = usePatchStore.getState().serialize()
  bundle.doc.transact(() => {
    for (const node of document.nodes) bundle.nodes.set(node.id, sanitizeNode(node))
    for (const edge of document.edges) bundle.edges.set(edge.id, sanitizeEdge(edge))
    bundle.meta.set(NAME_FIELD, document.name)
    bundle.meta.set(RESOLUTION_FIELD, {
      width: document.resolution.width,
      height: document.resolution.height,
    })
    bundle.meta.set(SEEDED_FIELD, true)
  }, LOCAL_ORIGIN)
  captureBaseline(bundle)
}

/**
 * Adopts the room's existing patch, discarding the local one.
 *
 * Applied through `applyRemote`, not `load`: `load` commits, which would fire
 * `onCommit`, which would push a full `replaceAll` of the adopted patch straight
 * back into the document we just read it from. `applyRemote` also keeps the
 * adoption out of the local undo stack, which is right — undoing "I joined a
 * session" should not push your patch over everyone else's.
 */
const adoptRemote = (bundle: Bundle): void => {
  const nodes: PatchNode[] = []
  const known = new Set<string>()
  let skipped = 0
  for (const raw of bundle.nodes.values()) {
    const entry = parseNodeEntry(raw)
    if (entry === null) continue
    if (!operatorMap.has(entry.data.op)) {
      skipped += 1
      continue
    }
    known.add(entry.id)
    nodes.push(toPatchNode(entry))
  }
  const edges: PatchEdge[] = []
  for (const raw of bundle.edges.values()) {
    const entry = parseEdgeEntry(raw)
    if (entry === null) continue
    if (!known.has(entry.source) || !known.has(entry.target)) continue
    edges.push(toPatchEdge(entry))
  }
  if (skipped > 0) {
    console.warn(`[session] ignored ${skipped} operator(s) this build does not have`)
  }

  const state = usePatchStore.getState()
  const mutations: Mutation[] = [
    {
      type: 'replaceAll',
      before: { nodes: structuredClone(state.nodes), edges: structuredClone(state.edges) },
      after: { nodes, edges },
    },
  ]
  const resolution = parseResolution(bundle.meta.get(RESOLUTION_FIELD))
  if (
    resolution !== null &&
    (resolution.width !== state.resolution.width || resolution.height !== state.resolution.height)
  ) {
    mutations.push({ type: 'setResolution', before: state.resolution, after: resolution })
  }

  const adoptedName = bundle.meta.get(NAME_FIELD)
  if (typeof adoptedName === 'string' && adoptedName.length > 0 && adoptedName !== state.name) {
    mutations.push({ type: 'setName', before: state.name, after: adoptedName })
  }

  // Every provenance entry already in the room is history we did not witness;
  // mark it seen so joining does not replay someone else's afternoon.
  for (const raw of bundle.log.toArray()) {
    const entry = parseLogEntry(raw)
    if (entry !== null) seenLogIds.add(entry.id)
  }

  state.applyRemote({
    id: uid('rmt'),
    at: Date.now(),
    actor: { id: 'session', name: `Room ${room}`, kind: 'human', color: '#69b7ff' },
    kind: 'document',
    label: `Adopted the patch already in room ${room}`,
    targets: [],
    mutations,
  })

  const name = bundle.meta.get(NAME_FIELD)
  if (typeof name === 'string' && name.length > 0 && name !== usePatchStore.getState().name) {
    state.setName(name, { id: 'session', name: 'Collab', kind: 'human', color: '#69b7ff' })
  }
  state.select([])
  state.clearHistory()

  // The adopted patch *is* the agreement, so nothing looks like drift and the
  // local patch we just discarded is not pushed back over the room.
  captureBaseline(bundle)
}

/**
 * FIRST-JOIN RULE
 *
 * Runs exactly once per join, on the first successful sync — never on a
 * reconnect (`bootstrapped` latches).
 *
 *   the room has been seeded  -> adopt it, throw away the local patch
 *   the room has never been seeded -> seed it from the local patch
 *
 * Authority is the explicit `meta.seeded` flag, not "are there any nodes". A
 * room whose patch was legitimately emptied (every operator deleted) still
 * counts as seeded, so the next person to join does not re-seed it and
 * resurrect a patch the group had just cleared. The `nodes.size > 0` fallback
 * only ever adds caution: it treats a doc written by a build that predates the
 * flag as seeded, so the failure mode is "adopt something" rather than "wipe
 * the host's work" — the direction that loses no data.
 *
 * The decision is taken after the sync handshake completes, so it is made
 * against the server's state and not against our own empty doc.
 */
const bootstrap = (): void => {
  const bundle = containers()
  if (bundle === null || bootstrapped) return
  bootstrapped = true

  const alreadySeeded = bundle.meta.get(SEEDED_FIELD) === true || bundle.nodes.size > 0
  if (alreadySeeded) {
    adoptRemote(bundle)
    adoptedRemote = true
  } else {
    seedFromLocal(bundle)
    adoptedRemote = false
  }

  shared = true

  // Bridges come up only now, so edits made while connecting are either
  // included in the seed or intentionally discarded by adoption — never
  // half-applied.
  teardown.push(usePatchStore.getState().onCommit(pushRecord))
  teardown.push(
    usePatchStore.subscribe((next, prev) => {
      if (next.selectedNodeIds !== prev.selectedNodeIds) setLocalSelection(next.selectedNodeIds)
      if (next.nodes !== prev.nodes || next.edges !== prev.edges || next.name !== prev.name) scheduleDrift()
    }),
  )
  setLocalSelection(usePatchStore.getState().selectedNodeIds)

  bundle.nodes.observe(observeRemote)
  bundle.edges.observe(observeRemote)
  bundle.meta.observe(observeRemote)
  bundle.log.observe(observeRemote)
  teardown.push(() => {
    bundle.nodes.unobserve(observeRemote)
    bundle.edges.unobserve(observeRemote)
    bundle.meta.unobserve(observeRemote)
    bundle.log.unobserve(observeRemote)
  })

  publish()
}

// ------------------------------------------------------------- lifecycle ----

/**
 * Joins a room, or does nothing if already in it.
 *
 * Idempotent on purpose: several components call `useSession()`, and a React
 * StrictMode double-mount calls the auto-join effect twice. Both must result in
 * exactly one WebSocket. Joining a room the session has already given up on
 * (`fatal`) is the exception, and retries.
 */
export function joinSession(next?: string): void {
  const target = normalizeRoom(next ?? room)
  if (provider !== null && target === room && !fatal) return
  if (provider !== null) leaveSession({ keepQuery: true })

  room = target
  rememberRoom(room)
  syncRoomUrl(room)
  socketStatus = 'connecting'
  errorMessage = null
  fatal = false
  hasEverConnected = false
  shared = false
  adoptedRemote = false
  bootstrapped = false
  seenLogIds.clear()

  const nextDoc = new Y.Doc()
  let nextProvider: WebsocketProvider
  try {
    // The room server exposes Yjs sync at `<base>/yjs/<room>`, and
    // WebsocketProvider appends the room name to the base url it is given.
    nextProvider = new WebsocketProvider(`${resolveServerUrl()}/yjs`, room, nextDoc)
  } catch (err) {
    nextDoc.destroy()
    fatal = true
    errorMessage = err instanceof Error ? err.message : 'Could not open a session socket.'
    publish()
    return
  }

  doc = nextDoc
  provider = nextProvider
  nodesMap = nextDoc.getMap<unknown>(NODES_KEY)
  edgesMap = nextDoc.getMap<unknown>(EDGES_KEY)
  metaMap = nextDoc.getMap<unknown>(META_KEY)
  logArray = nextDoc.getArray<unknown>(LOG_KEY)

  const onStatus = (event: { status: 'connected' | 'disconnected' | 'connecting' }): void => {
    socketStatus = event.status
    if (event.status === 'connected') {
      hasEverConnected = true
      errorMessage = null
    } else if (event.status === 'disconnected' && hasEverConnected) {
      errorMessage = 'Connection lost — retrying.'
    }
    publish()
  }
  const onSync = (isSynced: boolean): void => {
    if (isSynced) bootstrap()
    publish()
  }
  const onConnectionError = (): void => {
    errorMessage = `Could not reach the room server at ${resolveServerUrl()}.`
    publish()
  }
  const onClosed = (event: { code: number; reason: string }): void => {
    // y-websocket only emits `closed` when it has given up reconnecting.
    fatal = true
    errorMessage = `Session closed (${event.code}${event.reason ? `: ${event.reason}` : ''}).`
    publish()
  }

  nextProvider.on('status', onStatus)
  nextProvider.on('sync', onSync)
  nextProvider.on('connection-error', onConnectionError)
  nextProvider.on('closed', onClosed)
  teardown.push(() => {
    nextProvider.off('status', onStatus)
    nextProvider.off('sync', onSync)
    nextProvider.off('connection-error', onConnectionError)
    nextProvider.off('closed', onClosed)
  })

  // Subscribe before attaching, so the self-presence published by `attach` is
  // already reflected in the first snapshot.
  teardown.push(
    subscribePresence((peers) => {
      const signature = presenceSignature(peers)
      if (signature === peerSignature) return
      peerSignature = signature
      peerList = peers
      publish()
    }),
  )
  attachAwareness(nextProvider.awareness)

  publish()
}

/**
 * Leaves the session and keeps the patch as local state.
 *
 * Nothing is applied to or removed from the store: whatever is on screen —
 * including everything the collaborators contributed — stays exactly as it is,
 * it simply stops being shared.
 */
export function leaveSession(options?: { keepQuery?: boolean }): void {
  if (driftTimer !== null) {
    clearTimeout(driftTimer)
    driftTimer = null
  }
  // A queued reconcile must not fire against a torn-down document.
  reconcileQueued = false

  while (teardown.length > 0) {
    const dispose = teardown.pop()
    try {
      dispose?.()
    } catch (err) {
      console.error('[session] teardown failed:', err)
    }
  }

  detachAwareness()

  if (provider !== null) {
    try {
      provider.destroy()
    } catch (err) {
      console.warn('[session] provider teardown:', err)
    }
  }
  // Destroying the doc also destroys the awareness instance the provider made.
  doc?.destroy()

  provider = null
  doc = null
  nodesMap = null
  edgesMap = null
  metaMap = null
  logArray = null

  bootstrapped = false
  shared = false
  adoptedRemote = false
  baseNodes = new Map()
  baseEdges = new Map()
  baseName = null
  baseResolution = null
  socketStatus = 'disconnected'
  hasEverConnected = false
  fatal = false
  errorMessage = null
  peerList = []
  peerSignature = ''
  seenLogIds.clear()

  // `room` is deliberately left alone: the QR codes in the Session panel stay
  // valid and rejoining lands in the same room.
  if (!options?.keepQuery) syncRoomUrl(null)
  publish()
}

// ----------------------------------------------------------------- links ----

/** Editor URL that drops another browser straight into this room. */
export function inviteUrl(): string {
  const base = typeof location === 'undefined' ? 'http://localhost:5173' : location.origin
  const url = new URL('/', `${base}/`)
  url.searchParams.set('room', room)
  return url.toString()
}

export async function copyInviteLink(): Promise<void> {
  const link = inviteUrl()
  try {
    await navigator.clipboard.writeText(link)
  } catch {
    // Clipboard access needs a secure context and a user gesture; when it is
    // refused, say so rather than failing silently or throwing into a handler.
    errorMessage = `Clipboard blocked — the invite link is ${link}`
    publish()
  }
}
