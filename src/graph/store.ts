/**
 * The patch store.
 *
 * Everything that mutates the graph goes through `commit`, which records a
 * reversible `ChangeRecord` attributed to an actor. The UI, the WebMCP tools,
 * and remote collaborators all use the same entry points, so history and
 * provenance are correct no matter who made the edit.
 */

import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react'
import { create } from 'zustand'
import { getOperator, operatorMap } from '../engine/ops'
import type { OperatorSpec, ParamSpec } from '../engine/ops/kit'
import {
  isParamHandle,
  paramKeyFromHandle,
  type Actor,
  type ChangeKind,
  type ChangeRecord,
  type EdgeData,
  type Mutation,
  type ParamValue,
  type PatchDocument,
  type PatchEdge,
  type PatchNode,
  type Resolution,
} from './types'

const clone = <T>(value: T): T => structuredClone(value)

const uid = (prefix: string): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`

export const LOCAL_ACTOR: Actor = {
  id: uid('you'),
  name: 'You',
  kind: 'human',
  color: '#b9ff66',
}

export const AGENT_ACTOR: Actor = {
  id: 'agent',
  name: 'Agent',
  kind: 'agent',
  color: '#69b7ff',
}

// ------------------------------------------------------------- parameters ----

/** Full parameter set for a node: operator defaults overlaid with overrides. */
export function resolveParams(node: PatchNode): Record<string, ParamValue> {
  const spec = getOperator(node.data.op)
  const resolved: Record<string, ParamValue> = {}
  if (!spec) return resolved
  for (const param of spec.params) {
    const override = node.data.params[param.key]
    resolved[param.key] = override !== undefined ? override : (param.default as ParamValue)
  }
  return resolved
}

export function paramValue(node: PatchNode, key: string): ParamValue | undefined {
  const override = node.data.params[key]
  if (override !== undefined) return override
  return getOperator(node.data.op)?.params.find((param) => param.key === key)?.default as
    | ParamValue
    | undefined
}

/** Clamps and type-coerces a value against its parameter declaration. */
export function coerceParam(param: ParamSpec, value: unknown): ParamValue {
  switch (param.kind) {
    case 'bool':
      return value === true || value === 1 || value === 'true'
    case 'int': {
      const parsed = Math.round(Number(value))
      const safe = Number.isFinite(parsed) ? parsed : Number(param.default)
      return clampNumber(safe, param)
    }
    case 'menu': {
      const options = param.options ?? []
      if (typeof value === 'string') {
        const index = options.findIndex(
          (option) => option.toLowerCase() === value.trim().toLowerCase(),
        )
        if (index >= 0) return index
      }
      const parsed = Math.round(Number(value))
      const safe = Number.isFinite(parsed) ? parsed : Number(param.default)
      return Math.min(Math.max(safe, 0), Math.max(0, options.length - 1))
    }
    case 'float': {
      const parsed = Number(value)
      const safe = Number.isFinite(parsed) ? parsed : Number(param.default)
      return clampNumber(safe, param)
    }
    case 'color': {
      if (Array.isArray(value)) {
        const channels = [0, 1, 2, 3].map((index) => {
          const channel = Number(value[index])
          return Number.isFinite(channel) ? channel : index === 3 ? 1 : 0
        })
        return [channels[0], channels[1], channels[2], channels[3]]
      }
      if (typeof value === 'string') {
        const parsed = parseHexColor(value)
        if (parsed) return parsed
      }
      return param.default as [number, number, number, number]
    }
    default:
      return typeof value === 'string' ? value : String(value ?? '')
  }
}

function clampNumber(value: number, param: ParamSpec): number {
  // Parameters driven by a CHOP routinely exceed their slider range on purpose,
  // so the clamp is deliberately generous: it only guards against nonsense.
  const min = param.min ?? -1e6
  const max = param.max ?? 1e6
  const slack = Math.max(1, Math.abs(max - min)) * 4
  return Math.min(Math.max(value, min - slack), max + slack)
}

function parseHexColor(input: string): [number, number, number, number] | null {
  const match = /^#?([0-9a-f]{3,8})$/i.exec(input.trim())
  if (!match) return null
  let hex = match[1]
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('')
  if (hex.length === 6) hex += 'ff'
  if (hex.length !== 8) return null
  const channel = (index: number) => parseInt(hex.slice(index * 2, index * 2 + 2), 16) / 255
  return [channel(0), channel(1), channel(2), channel(3)]
}

// ------------------------------------------------------------------ nodes ----

export function createNode(op: string, position: XYPosition, id = uid(op)): PatchNode {
  const spec = operatorMap.get(op)
  if (!spec) throw new Error(`Unknown operator "${op}".`)
  return {
    id,
    type: 'operator',
    position,
    data: { op, name: spec.label, enabled: true, bypass: false, params: {} },
  }
}

/** First free slot on a loose grid, so new nodes never land on top of each other. */
function freePosition(nodes: PatchNode[], near?: XYPosition): XYPosition {
  const originX = near ? near.x : 80
  const originY = near ? near.y : 120
  for (let ring = 0; ring < 24; ring += 1) {
    for (let column = 0; column <= ring; column += 1) {
      const candidate = { x: originX + column * 260, y: originY + (ring - column) * 190 }
      const collides = nodes.some(
        (node) =>
          Math.abs(node.position.x - candidate.x) < 210 &&
          Math.abs(node.position.y - candidate.y) < 150,
      )
      if (!collides) return candidate
    }
  }
  return { x: originX, y: originY + nodes.length * 190 }
}

// ------------------------------------------------------------ connections ----

export type ConnectionCheck = { ok: true } | { ok: false; reason: string }

function portKind(
  spec: OperatorSpec | undefined,
  handle: string | null | undefined,
  direction: 'input' | 'output',
): 'texture' | 'number' | null {
  if (!spec || !handle) return null
  if (isParamHandle(handle)) {
    const key = paramKeyFromHandle(handle)
    const param = spec.params.find((candidate) => candidate.key === key)
    return param?.modulatable ? 'number' : null
  }
  const ports = direction === 'input' ? spec.inputs : spec.outputs
  return ports.find((port) => port.id === handle)?.type ?? null
}

/**
 * Validates a proposed link. Shared by the canvas, keyboard-driven wiring, and
 * WebMCP so an agent gets the same errors a human would see.
 */
export function checkConnection(
  nodes: PatchNode[],
  edges: PatchEdge[],
  connection: Connection,
): ConnectionCheck {
  if (!connection.source || !connection.target) return { ok: false, reason: 'Incomplete link.' }
  if (connection.source === connection.target) {
    return { ok: false, reason: 'An operator cannot be wired to itself.' }
  }

  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return { ok: false, reason: 'One end of the link does not exist.' }

  const sourceSpec = getOperator(source.data.op)
  const targetSpec = getOperator(target.data.op)
  const outKind = portKind(sourceSpec, connection.sourceHandle, 'output')
  const inKind = portKind(targetSpec, connection.targetHandle, 'input')

  if (!outKind) return { ok: false, reason: `${source.data.name} has no such output.` }
  if (!inKind) {
    return isParamHandle(connection.targetHandle)
      ? { ok: false, reason: 'That parameter cannot be driven by a signal.' }
      : { ok: false, reason: `${target.data.name} has no such input.` }
  }
  if (outKind !== inKind) {
    return {
      ok: false,
      reason: `Cannot connect a ${outKind.toUpperCase()} output to a ${inKind.toUpperCase()} input.`,
    }
  }

  const occupied = edges.some(
    (edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle,
  )
  if (occupied) return { ok: false, reason: 'That input is already connected.' }

  if (createsCycle(nodes, edges, connection.source, connection.target)) {
    return {
      ok: false,
      reason: 'That link would create a feedback loop. Insert a Feedback operator to break it.',
    }
  }

  return { ok: true }
}

/**
 * Cycle test that ignores delayed ports, because a Feedback operator reads the
 * previous frame and therefore does not participate in this frame's ordering.
 */
function createsCycle(
  nodes: PatchNode[],
  edges: PatchEdge[],
  from: string,
  to: string,
): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (isDelayedEdge(nodes, edge)) continue
    const list = adjacency.get(edge.source)
    if (list) list.push(edge.target)
    else adjacency.set(edge.source, [edge.target])
  }
  const list = adjacency.get(from)
  if (list) list.push(to)
  else adjacency.set(from, [to])

  const stack = [to]
  const seen = new Set<string>()
  while (stack.length) {
    const current = stack.pop()!
    if (current === from) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return false
}

export function isDelayedEdge(nodes: PatchNode[], edge: PatchEdge): boolean {
  const target = nodes.find((node) => node.id === edge.target)
  const spec = getOperator(target?.data.op)
  return spec?.inputs.some((port) => port.id === edge.targetHandle && port.delayed) ?? false
}

// ------------------------------------------------------------ starter set ----

function starterPatch(): { nodes: PatchNode[]; edges: PatchEdge[] } {
  const noise = createNode('noise-top', { x: 40, y: 60 }, 'noise-1')
  noise.data.params = { type: 3, scale: 3.2, speed: 0.12, contrast: 1.6 }

  const ramp = createNode('ramp', { x: 40, y: 300 }, 'ramp-1')
  ramp.data.params = {
    type: 1,
    colorA: [0.9, 0.2, 0.55, 1],
    colorB: [0.03, 0.05, 0.12, 1],
    scale: 1.4,
  }

  const composite = createNode('composite', { x: 320, y: 170 }, 'comp-1')
  composite.data.params = { blend: 4, opacity: 1 }

  const glitch = createNode('glitch', { x: 600, y: 170 }, 'glitch-1')
  glitch.data.params = { amount: 0.55 }

  const bloom = createNode('bloom', { x: 880, y: 170 }, 'bloom-1')
  bloom.data.params = { threshold: 0.55, intensity: 0.9 }

  const out = createNode('out', { x: 1160, y: 170 }, 'out-1')

  const band = createNode('audio-band', { x: 600, y: 430 }, 'band-1')
  const lfo = createNode('lfo', { x: 320, y: 430 }, 'lfo-1')
  lfo.data.params = { frequency: 0.08, amplitude: 0.5, offset: 0.5 }

  const edge = (
    id: string,
    source: string,
    target: string,
    targetHandle: string,
    kind: 'texture' | 'number',
    sourceHandle = 'out',
  ): PatchEdge => ({
    id,
    source,
    sourceHandle,
    target,
    targetHandle,
    data: { kind },
  })

  return {
    nodes: [noise, ramp, composite, glitch, bloom, out, lfo, band],
    edges: [
      edge('e1', 'ramp-1', 'comp-1', 'in-0', 'texture'),
      edge('e2', 'noise-1', 'comp-1', 'in-1', 'texture'),
      edge('e3', 'comp-1', 'glitch-1', 'in-0', 'texture'),
      edge('e4', 'glitch-1', 'bloom-1', 'in-0', 'texture'),
      edge('e5', 'bloom-1', 'out-1', 'in-0', 'texture'),
      edge('e6', 'lfo-1', 'noise-1', 'param:scale', 'number'),
      edge('e7', 'band-1', 'glitch-1', 'param:amount', 'number'),
    ],
  }
}

// ------------------------------------------------------------------ store ----

export type PatchState = {
  nodes: PatchNode[]
  edges: PatchEdge[]
  name: string
  resolution: Resolution

  selectedNodeIds: string[]
  selectedEdgeId: string | null
  libraryOpen: boolean
  libraryAnchor: XYPosition | null

  playing: boolean
  targetFps: number

  history: ChangeRecord[]
  undone: ChangeRecord[]
  changeLog: ChangeRecord[]

  actor: Actor

  // React Flow plumbing
  onNodesChange: (changes: NodeChange<PatchNode>[]) => void
  onEdgesChange: (changes: EdgeChange<PatchEdge>[]) => void
  onConnect: (connection: Connection) => void
  isValidConnection: (connection: Connection | PatchEdge) => boolean

  // Editing
  addOperator: (op: string, position?: XYPosition, actor?: Actor) => string
  deleteNodes: (ids: string[], actor?: Actor) => void
  duplicateNodes: (ids: string[], actor?: Actor) => string[]
  copySelection: () => void
  paste: (actor?: Actor) => string[]
  connect: (connection: Connection, actor?: Actor) => ConnectionCheck
  disconnect: (edgeId: string, actor?: Actor) => void
  setParam: (nodeId: string, key: string, value: unknown, actor?: Actor) => void
  resetParam: (nodeId: string, key: string, actor?: Actor) => void
  setField: (
    nodeId: string,
    key: 'name' | 'enabled' | 'bypass' | 'comment',
    value: unknown,
    actor?: Actor,
  ) => void
  moveNode: (nodeId: string, position: XYPosition, actor?: Actor, initialBefore?: XYPosition) => void
  insertBetween: (edgeId: string, op: string, actor?: Actor) => string | null

  // Selection & UI
  select: (ids: string[]) => void
  selectEdge: (id: string | null) => void
  openLibrary: (anchor?: XYPosition | null) => void
  closeLibrary: () => void
  setPlaying: (playing: boolean) => void
  setTargetFps: (fps: number) => void
  setResolution: (resolution: Resolution, actor?: Actor) => void
  setName: (name: string, actor?: Actor) => void

  // History
  undo: () => void
  redo: () => void
  revertChanges: (filter: (record: ChangeRecord) => boolean, label: string) => number
  clearHistory: () => void

  // Documents
  serialize: () => PatchDocument
  load: (document: PatchDocument, actor?: Actor) => void
  reset: (actor?: Actor) => void

  /** Applies remote mutations without touching the local undo stack. */
  applyRemote: (record: ChangeRecord) => void
  /** Notified after every local commit, for the collaboration layer. */
  onCommit: (listener: (record: ChangeRecord) => void) => () => void
}

const commitListeners = new Set<(record: ChangeRecord) => void>()
const dragStartPositions = new Map<string, XYPosition>()

const CLIPBOARD_KEY = 'visual-engine:clipboard:v1'
type ClipboardPayload = { nodes: PatchNode[]; edges: PatchEdge[] }

function readClipboard(): ClipboardPayload | null {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ClipboardPayload
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) return null
    return parsed
  } catch {
    return null
  }
}

function writeClipboard(payload: ClipboardPayload): void {
  try {
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(payload))
  } catch {
    // ignore
  }
}

const MAX_HISTORY = 400

export const usePatchStore = create<PatchState>((set, get) => {
  /** Applies mutations to a working copy of the graph. */
  function apply(
    state: { nodes: PatchNode[]; edges: PatchEdge[]; resolution: Resolution; name: string },
    mutations: Mutation[],
  ): { nodes: PatchNode[]; edges: PatchEdge[]; resolution: Resolution; name: string } {
    let nodes = state.nodes
    let edges = state.edges
    let resolution = state.resolution
    let nextName = state.name

    for (const mutation of mutations) {
      switch (mutation.type) {
        case 'addNode':
          nodes = [...nodes.filter((node) => node.id !== mutation.node.id), clone(mutation.node)]
          break
        case 'removeNode':
          nodes = nodes.filter((node) => node.id !== mutation.node.id)
          edges = edges.filter(
            (edge) => edge.source !== mutation.node.id && edge.target !== mutation.node.id,
          )
          break
        case 'addEdge':
          edges = [...edges.filter((edge) => edge.id !== mutation.edge.id), clone(mutation.edge)]
          break
        case 'removeEdge':
          edges = edges.filter((edge) => edge.id !== mutation.edge.id)
          break
        case 'setParam':
          nodes = nodes.map((node) => {
            if (node.id !== mutation.nodeId) return node
            const params = { ...node.data.params }
            if (mutation.after === undefined) delete params[mutation.key]
            else params[mutation.key] = mutation.after
            return { ...node, data: { ...node.data, params } }
          })
          break
        case 'setField':
          nodes = nodes.map((node) =>
            node.id === mutation.nodeId
              ? { ...node, data: { ...node.data, [mutation.key]: mutation.after } }
              : node,
          )
          break
        case 'move':
          nodes = nodes.map((node) =>
            node.id === mutation.nodeId ? { ...node, position: { ...mutation.after } } : node,
          )
          break
        case 'replaceAll':
          nodes = clone(mutation.after.nodes)
          edges = clone(mutation.after.edges)
          break
        case 'setResolution':
          resolution = { ...mutation.after }
          break
        case 'setName':
          nextName = mutation.after
          break
      }
    }

    return { nodes, edges, resolution, name: nextName }
  }

  function invert(mutations: Mutation[]): Mutation[] {
    return [...mutations].reverse().map((mutation): Mutation => {
      switch (mutation.type) {
        case 'addNode':
          return { type: 'removeNode', node: mutation.node }
        case 'removeNode':
          return { type: 'addNode', node: mutation.node }
        case 'addEdge':
          return { type: 'removeEdge', edge: mutation.edge }
        case 'removeEdge':
          return { type: 'addEdge', edge: mutation.edge }
        case 'setParam':
          return { ...mutation, before: mutation.after, after: mutation.before }
        case 'setField':
          return { ...mutation, before: mutation.after, after: mutation.before }
        case 'move':
          return { type: 'move', nodeId: mutation.nodeId, before: mutation.after, after: mutation.before }
        case 'replaceAll':
          return { type: 'replaceAll', before: mutation.after, after: mutation.before }
        case 'setResolution':
          return { type: 'setResolution', before: mutation.after, after: mutation.before }
        case 'setName':
          return { type: 'setName', before: mutation.after, after: mutation.before }
      }
    })
  }

  /**
   * Removing a node also removes its edges, but the plain `removeNode` mutation
   * cannot restore them on undo. So deletions are expanded into explicit edge
   * removals first, which makes them exactly reversible.
   */
  function expandDeletion(nodes: PatchNode[], edges: PatchEdge[], ids: Set<string>): Mutation[] {
    const mutations: Mutation[] = []
    for (const edge of edges) {
      if (ids.has(edge.source) || ids.has(edge.target)) {
        mutations.push({ type: 'removeEdge', edge: clone(edge) })
      }
    }
    for (const node of nodes) {
      if (ids.has(node.id)) mutations.push({ type: 'removeNode', node: clone(node) })
    }
    return mutations
  }

  function commit(
    label: string,
    kind: ChangeKind,
    mutations: Mutation[],
    actor: Actor | undefined,
    targets: string[] = [],
  ): ChangeRecord | null {
    if (!mutations.length) return null

    const record: ChangeRecord = {
      id: uid('chg'),
      at: Date.now(),
      actor: actor ?? get().actor,
      kind,
      label,
      targets,
      mutations,
    }

    set((state) => {
      const next = apply(state, mutations)
      return {
        ...next,
        history: [...state.history, record].slice(-MAX_HISTORY),
        undone: [],
        changeLog: [...state.changeLog, record].slice(-MAX_HISTORY),
      }
    })

    for (const listener of commitListeners) listener(record)
    return record
  }

  const starter = starterPatch()

  return {
    nodes: starter.nodes,
    edges: starter.edges,
    name: 'Untitled Patch',
    resolution: { width: 1280, height: 720 },

    selectedNodeIds: ['glitch-1'],
    selectedEdgeId: null,
    libraryOpen: false,
    libraryAnchor: null,

    playing: true,
    targetFps: 60,

    history: [],
    undone: [],
    changeLog: [],

    actor: LOCAL_ACTOR,

    // ------------------------------------------------------ react flow ----

    onNodesChange: (changes) => {
      // Record starting positions before dragging begins
      const currentState = get()
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === true) {
          if (!dragStartPositions.has(change.id)) {
            const node = currentState.nodes.find((n) => n.id === change.id)
            if (node) dragStartPositions.set(change.id, { ...node.position })
          }
        }
      }

      // Position changes are committed on drag end (see `moveNode`), so the
      // history does not fill with one entry per mouse move.
      const structural = changes.filter(
        (change) => change.type !== 'position' || change.dragging !== false,
      )
      set((state) => ({ nodes: applyNodeChanges(structural, state.nodes) }))

      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          const before = dragStartPositions.get(change.id)
          dragStartPositions.delete(change.id)
          get().moveNode(change.id, change.position, undefined, before)
        }
      }

      const selected = changes.filter(
        (change): change is Extract<NodeChange<PatchNode>, { type: 'select' }> =>
          change.type === 'select',
      )
      if (selected.length) {
        set((state) => ({
          selectedNodeIds: state.nodes.filter((node) => node.selected).map((node) => node.id),
        }))
      }
    },

    onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),

    onConnect: (connection) => {
      get().connect(connection)
    },

    isValidConnection: (candidate) => {
      const state = get()
      const connection: Connection = {
        source: candidate.source ?? '',
        target: candidate.target ?? '',
        sourceHandle: candidate.sourceHandle ?? null,
        targetHandle: candidate.targetHandle ?? null,
      }
      return checkConnection(state.nodes, state.edges, connection).ok
    },

    // --------------------------------------------------------- editing ----

    addOperator: (op, position, actor) => {
      const state = get()
      const node = createNode(op, position ?? freePosition(state.nodes, state.libraryAnchor ?? undefined))
      commit(`Created ${node.data.name}`, 'create', [{ type: 'addNode', node }], actor, [node.id])
      set((s) => ({
        selectedNodeIds: [node.id],
        selectedEdgeId: null,
        libraryOpen: false,
        nodes: s.nodes.map((n) => ({ ...n, selected: n.id === node.id })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
      return node.id
    },

    deleteNodes: (ids, actor) => {
      const state = get()
      const set_ = new Set(ids)
      const mutations = expandDeletion(state.nodes, state.edges, set_)
      if (!mutations.length) return
      const names = state.nodes.filter((node) => set_.has(node.id)).map((node) => node.data.name)
      commit(
        names.length === 1 ? `Deleted ${names[0]}` : `Deleted ${names.length} operators`,
        'delete',
        mutations,
        actor,
        ids,
      )
      set((s) => ({
        selectedNodeIds: [],
        selectedEdgeId: null,
        nodes: s.nodes.map((n) => ({ ...n, selected: false })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
    },

    duplicateNodes: (ids, actor) => {
      const state = get()
      const selected = state.nodes.filter((node) => ids.includes(node.id))
      if (!selected.length) return []

      const idMap = new Map(selected.map((node) => [node.id, uid(node.data.op)]))
      const mutations: Mutation[] = selected.map((node) => ({
        type: 'addNode',
        node: {
          ...clone(node),
          id: idMap.get(node.id)!,
          position: { x: node.position.x + 48, y: node.position.y + 48 },
          selected: false,
        },
      }))

      // Internal wiring is preserved; links to nodes outside the selection are
      // dropped, which matches what a copy/paste should do.
      for (const edge of state.edges) {
        const source = idMap.get(edge.source)
        const target = idMap.get(edge.target)
        if (!source || !target) continue
        mutations.push({
          type: 'addEdge',
          edge: { ...clone(edge), id: uid('e'), source, target },
        })
      }

      const newIds = Array.from(idMap.values())
      commit(
        selected.length === 1 ? `Duplicated ${selected[0].data.name}` : `Duplicated ${selected.length} operators`,
        'create',
        mutations,
        actor,
        newIds,
      )
      set((s) => ({
        selectedNodeIds: newIds,
        selectedEdgeId: null,
        nodes: s.nodes.map((n) => ({ ...n, selected: newIds.includes(n.id) })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
      return newIds
    },

    copySelection: () => {
      const state = get()
      const selectedIds = new Set(state.selectedNodeIds)
      if (!selectedIds.size) return
      const nodes = state.nodes.filter((node) => selectedIds.has(node.id))
      const edges = state.edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
      writeClipboard({ nodes: clone(nodes), edges: clone(edges) })
    },

    paste: (actor) => {
      const clipboard = readClipboard()
      if (!clipboard?.nodes.length) return []
      const idMap = new Map(clipboard.nodes.map((node) => [node.id, uid(node.data.op)]))
      const mutations: Mutation[] = clipboard.nodes.map((node) => ({
        type: 'addNode',
        node: {
          ...clone(node),
          id: idMap.get(node.id)!,
          position: { x: node.position.x + 48, y: node.position.y + 48 },
          selected: false,
        },
      }))
      for (const edge of clipboard.edges) {
        const source = idMap.get(edge.source)
        const target = idMap.get(edge.target)
        if (!source || !target) continue
        mutations.push({
          type: 'addEdge',
          edge: { ...clone(edge), id: uid('e'), source, target },
        })
      }
      const newIds = Array.from(idMap.values())
      commit(
        clipboard.nodes.length === 1
          ? `Pasted ${clipboard.nodes[0].data.name}`
          : `Pasted ${clipboard.nodes.length} operators`,
        'create',
        mutations,
        actor,
        newIds,
      )
      set((s) => ({
        selectedNodeIds: newIds,
        selectedEdgeId: null,
        nodes: s.nodes.map((n) => ({ ...n, selected: newIds.includes(n.id) })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
      return newIds
    },

    connect: (connection, actor) => {
      const state = get()
      const check = checkConnection(state.nodes, state.edges, connection)
      if (!check.ok) return check

      const source = state.nodes.find((node) => node.id === connection.source)!
      const sourceSpec = getOperator(source.data.op)
      const kind: EdgeData['kind'] =
        sourceSpec?.family === 'CHOP' || isParamHandle(connection.targetHandle) ? 'number' : 'texture'

      const edge: PatchEdge = {
        id: uid('e'),
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
        data: { kind },
      }

      const target = state.nodes.find((node) => node.id === connection.target)
      const label = isParamHandle(connection.targetHandle)
        ? `Wired ${source.data.name} to ${target?.data.name}.${paramKeyFromHandle(connection.targetHandle!)}`
        : `Connected ${source.data.name} to ${target?.data.name}`

      commit(label, 'connect', [{ type: 'addEdge', edge }], actor, [connection.source, connection.target])
      return { ok: true }
    },

    disconnect: (edgeId, actor) => {
      const state = get()
      const edge = state.edges.find((candidate) => candidate.id === edgeId)
      if (!edge) return
      const source = state.nodes.find((node) => node.id === edge.source)
      const target = state.nodes.find((node) => node.id === edge.target)
      commit(
        `Disconnected ${source?.data.name ?? '?'} from ${target?.data.name ?? '?'}`,
        'disconnect',
        [{ type: 'removeEdge', edge: clone(edge) }],
        actor,
        [edge.source, edge.target],
      )
      set({ selectedEdgeId: null })
    },

    setParam: (nodeId, key, value, actor) => {
      const state = get()
      const node = state.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const spec = getOperator(node.data.op)
      const param = spec?.params.find((candidate) => candidate.key === key)
      if (!param) return

      const next = coerceParam(param, value)
      const before = node.data.params[key]
      if (JSON.stringify(before) === JSON.stringify(next)) return

      commit(
        `${node.data.name}.${param.label} = ${formatParam(param, next)}`,
        'parameter',
        [{ type: 'setParam', nodeId, key, before, after: next }],
        actor,
        [nodeId],
      )
    },

    resetParam: (nodeId, key, actor) => {
      const state = get()
      const node = state.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.data.params[key] === undefined) return
      commit(
        `Reset ${node.data.name}.${key}`,
        'parameter',
        [{ type: 'setParam', nodeId, key, before: node.data.params[key], after: undefined }],
        actor,
        [nodeId],
      )
    },

    setField: (nodeId, key, value, actor) => {
      const state = get()
      const node = state.nodes.find((candidate) => candidate.id === nodeId)
      if (!node || node.data[key] === value) return

      // Coalesce rapid edits (such as typing in the comment box)
      const last = state.history.at(-1)
      if (
        key === 'comment' &&
        last &&
        last.kind === 'document' &&
        last.mutations.length === 1 &&
        last.mutations[0].type === 'setField' &&
        last.mutations[0].nodeId === nodeId &&
        last.mutations[0].key === 'comment' &&
        Date.now() - last.at < 1200
      ) {
        const merged: Mutation = { ...last.mutations[0], after: value }
        set((stateInner) => {
          const updatedHistory = [
            ...stateInner.history.slice(0, -1),
            { ...last, mutations: [merged], at: Date.now() },
          ]
          let lastLogIndex = -1
          for (let i = stateInner.changeLog.length - 1; i >= 0; i--) {
            if (stateInner.changeLog[i].id === last.id) {
              lastLogIndex = i
              break
            }
          }
          const updatedChangeLog =
            lastLogIndex >= 0
              ? [
                  ...stateInner.changeLog.slice(0, lastLogIndex),
                  { ...stateInner.changeLog[lastLogIndex], mutations: [merged], at: Date.now() },
                  ...stateInner.changeLog.slice(lastLogIndex + 1),
                ]
              : stateInner.changeLog
          return {
            nodes: apply(stateInner, [merged]).nodes,
            history: updatedHistory,
            changeLog: updatedChangeLog,
          }
        })
        return
      }

      const labels: Record<typeof key, string> = {
        name: 'Renamed',
        enabled: value ? 'Enabled' : 'Disabled',
        bypass: value ? 'Bypassed' : 'Un-bypassed',
        comment: 'Commented',
      }
      commit(
        `${labels[key]} ${key === 'name' ? `${node.data.name} to ${String(value)}` : node.data.name}`,
        key === 'name' || key === 'comment' ? 'document' : 'parameter',
        [{ type: 'setField', nodeId, key, before: node.data[key], after: value }],
        actor,
        [nodeId],
      )
    },

    moveNode: (nodeId, position, actor, initialBefore) => {
      const state = get()
      const node = state.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) return
      const beforePos = initialBefore ?? { ...node.position }
      if (beforePos.x === position.x && beforePos.y === position.y) return

      const last = state.history.at(-1)
      // Coalesce consecutive drags of the same node into one history entry.
      if (
        last &&
        last.kind === 'layout' &&
        last.mutations.length === 1 &&
        last.mutations[0].type === 'move' &&
        last.mutations[0].nodeId === nodeId &&
        Date.now() - last.at < 900
      ) {
        const merged: Mutation = { ...last.mutations[0], after: { ...position } }
        set((stateInner) => {
          const updatedHistory = [
            ...stateInner.history.slice(0, -1),
            { ...last, mutations: [merged], at: Date.now() },
          ]
          let lastLogIndex = -1
          for (let i = stateInner.changeLog.length - 1; i >= 0; i--) {
            if (stateInner.changeLog[i].id === last.id) {
              lastLogIndex = i
              break
            }
          }
          const updatedChangeLog =
            lastLogIndex >= 0
              ? [
                  ...stateInner.changeLog.slice(0, lastLogIndex),
                  { ...stateInner.changeLog[lastLogIndex], mutations: [merged], at: Date.now() },
                  ...stateInner.changeLog.slice(lastLogIndex + 1),
                ]
              : stateInner.changeLog
          return {
            nodes: apply(stateInner, [merged]).nodes,
            history: updatedHistory,
            changeLog: updatedChangeLog,
          }
        })
        return
      }

      commit(
        `Moved ${node.data.name}`,
        'layout',
        [{ type: 'move', nodeId, before: beforePos, after: { ...position } }],
        actor,
        [nodeId],
      )
    },

    insertBetween: (edgeId, op, actor) => {
      const state = get()
      const edge = state.edges.find((candidate) => candidate.id === edgeId)
      if (!edge) return null
      const source = state.nodes.find((node) => node.id === edge.source)
      const target = state.nodes.find((node) => node.id === edge.target)
      if (!source || !target) return null

      const spec = getOperator(op)
      if (!spec?.inputs.length || !spec.outputs.length) return null

      const node = createNode(op, {
        x: (source.position.x + target.position.x) / 2,
        y: (source.position.y + target.position.y) / 2 + 20,
      })

      const testNodes = [...state.nodes, node]
      const remainingEdges = state.edges.filter((e) => e.id !== edgeId)

      const firstLeg: Connection = {
        source: edge.source,
        sourceHandle: edge.sourceHandle ?? null,
        target: node.id,
        targetHandle: spec.inputs[0].id,
      }
      const firstCheck = checkConnection(testNodes, remainingEdges, firstLeg)
      if (!firstCheck.ok) return null

      const secondLeg: Connection = {
        source: node.id,
        sourceHandle: 'out',
        target: edge.target,
        targetHandle: edge.targetHandle ?? null,
      }
      const secondCheck = checkConnection(testNodes, remainingEdges, secondLeg)
      if (!secondCheck.ok) return null

      const firstSourceSpec = getOperator(source.data.op)
      const firstKind: EdgeData['kind'] =
        firstSourceSpec?.family === 'CHOP' || isParamHandle(firstLeg.targetHandle) ? 'number' : 'texture'

      const secondKind: EdgeData['kind'] =
        spec.family === 'CHOP' || isParamHandle(secondLeg.targetHandle) ? 'number' : 'texture'

      commit(
        `Inserted ${node.data.name} between ${source.data.name} and ${target.data.name}`,
        'create',
        [
          { type: 'removeEdge', edge: clone(edge) },
          { type: 'addNode', node },
          {
            type: 'addEdge',
            edge: {
              id: uid('e'),
              source: edge.source,
              sourceHandle: edge.sourceHandle,
              target: node.id,
              targetHandle: spec.inputs[0].id,
              data: { kind: firstKind },
            },
          },
          {
            type: 'addEdge',
            edge: {
              id: uid('e'),
              source: node.id,
              sourceHandle: 'out',
              target: edge.target,
              targetHandle: edge.targetHandle,
              data: { kind: secondKind },
            },
          },
        ],
        actor,
        [node.id],
      )
      set((s) => ({
        selectedNodeIds: [node.id],
        selectedEdgeId: null,
        nodes: s.nodes.map((n) => ({ ...n, selected: n.id === node.id })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
      return node.id
    },

    // -------------------------------------------------------- selection ----

    select: (ids) =>
      set((state) => ({
        selectedNodeIds: ids,
        selectedEdgeId: null,
        nodes: state.nodes.map((node) => ({ ...node, selected: ids.includes(node.id) })),
        edges: state.edges.map((edge) => ({ ...edge, selected: false })),
      })),

    selectEdge: (id) =>
      set((state) => ({
        selectedEdgeId: id,
        selectedNodeIds: [],
        nodes: state.nodes.map((node) => ({ ...node, selected: false })),
        edges: state.edges.map((edge) => ({ ...edge, selected: edge.id === id })),
      })),

    openLibrary: (anchor) => set({ libraryOpen: true, libraryAnchor: anchor ?? null }),
    closeLibrary: () => set({ libraryOpen: false }),
    setPlaying: (playing) => set({ playing }),
    setTargetFps: (targetFps) => set({ targetFps }),
    setName: (name, actor) => {
      const trimmed = name.trim() || 'Untitled Patch'
      if (trimmed === get().name) return
      commit(
        `Rename patch to "${trimmed}"`,
        'document',
        [{ type: 'setName', before: get().name, after: trimmed }],
        actor,
      )
    },

    setResolution: (resolution, actor) => {
      const before = get().resolution
      if (before.width === resolution.width && before.height === resolution.height) return
      commit(
        `Resolution ${resolution.width} × ${resolution.height}`,
        'document',
        [{ type: 'setResolution', before, after: resolution }],
        actor,
      )
    },

    // ---------------------------------------------------------- history ----

    undo: () => {
      const state = get()
      const record = state.history.at(-1)
      if (!record) return
      set((inner) => ({
        ...apply(inner, invert(record.mutations)),
        history: inner.history.slice(0, -1),
        undone: [record, ...inner.undone].slice(0, MAX_HISTORY),
      }))
    },

    redo: () => {
      const state = get()
      const record = state.undone[0]
      if (!record) return
      set((inner) => ({
        ...apply(inner, record.mutations),
        history: [...inner.history, record].slice(-MAX_HISTORY),
        undone: inner.undone.slice(1),
      }))
    },

    /**
     * Selectively reverses matching changes, newest first, leaving everything
     * else intact. This is what powers "undo everything the agent just did"
     * without throwing away concurrent human edits.
     */
    revertChanges: (filter, label) => {
      const state = get()
      const matching = state.changeLog.filter(filter)
      if (!matching.length) return 0

      const matchingIds = new Set(matching.map((entry) => entry.id))
      const mutations = matching
        .slice()
        .reverse()
        .flatMap((record) => invert(record.mutations))

      const record = commit(label, 'revert', mutations, state.actor, [
        ...new Set(matching.flatMap((entry) => entry.targets)),
      ])
      if (record) {
        set((s) => ({
          changeLog: s.changeLog.filter((entry) => !matchingIds.has(entry.id)),
        }))
      }
      return record ? matching.length : 0
    },

    clearHistory: () => set({ history: [], undone: [], changeLog: [] }),

    // -------------------------------------------------------- documents ----

    serialize: () => {
      const state = get()
      return {
        version: 3,
        name: state.name,
        resolution: state.resolution,
        savedAt: Date.now(),
        nodes: clone(state.nodes.map((node) => ({ ...node, selected: false, dragging: false }))),
        edges: clone(state.edges.map((edge) => ({ ...edge, selected: false }))),
      }
    },

    load: (document, actor) => {
      if (document?.version !== 3 || !Array.isArray(document.nodes)) {
        throw new Error('Unsupported patch file. Expected a version 3 document.')
      }
      const unknown = document.nodes
        .map((node) => node.data?.op)
        .filter((op) => op && !operatorMap.has(op))
      if (unknown.length) {
        throw new Error(`This patch uses operators this build does not have: ${[...new Set(unknown)].join(', ')}`)
      }

      const state = get()
      const targetName = document.name || 'Untitled Patch'
      const mutations: Mutation[] = [
        {
          type: 'replaceAll',
          before: { nodes: clone(state.nodes), edges: clone(state.edges) },
          after: { nodes: clone(document.nodes), edges: clone(document.edges ?? []) },
        },
      ]
      if (document.resolution) {
        mutations.push({
          type: 'setResolution',
          before: state.resolution,
          after: document.resolution,
        })
      }
      if (state.name !== targetName) {
        mutations.push({
          type: 'setName',
          before: state.name,
          after: targetName,
        })
      }

      commit(
        `Loaded "${document.name || 'patch'}"`,
        'document',
        mutations,
        actor,
      )
      set((s) => ({
        selectedNodeIds: [],
        selectedEdgeId: null,
        nodes: s.nodes.map((n) => ({ ...n, selected: false })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
    },

    reset: (actor) => {
      const state = get()
      const fresh = starterPatch()
      const defaultResolution: Resolution = { width: 1280, height: 720 }
      const defaultName = 'Untitled Patch'
      const mutations: Mutation[] = [
        {
          type: 'replaceAll',
          before: { nodes: clone(state.nodes), edges: clone(state.edges) },
          after: fresh,
        },
      ]
      if (
        state.resolution.width !== defaultResolution.width ||
        state.resolution.height !== defaultResolution.height
      ) {
        mutations.push({
          type: 'setResolution',
          before: state.resolution,
          after: defaultResolution,
        })
      }
      if (state.name !== defaultName) {
        mutations.push({
          type: 'setName',
          before: state.name,
          after: defaultName,
        })
      }

      commit(
        'Reset to the starter patch',
        'document',
        mutations,
        actor,
      )
      set((s) => ({
        selectedNodeIds: [],
        selectedEdgeId: null,
        nodes: s.nodes.map((n) => ({ ...n, selected: false })),
        edges: s.edges.map((e) => ({ ...e, selected: false })),
      }))
    },

    applyRemote: (record) => {
      set((state) => ({
        ...apply(state, record.mutations),
        changeLog: [...state.changeLog, record].slice(-MAX_HISTORY),
      }))
    },

    onCommit: (listener) => {
      commitListeners.add(listener)
      return () => commitListeners.delete(listener)
    },
  }
})

/** Compact display of a parameter value, for history labels and tooltips. */
export function formatParam(param: ParamSpec, value: ParamValue): string {
  switch (param.kind) {
    case 'bool':
      return value ? 'on' : 'off'
    case 'menu':
      return param.options?.[Number(value)] ?? String(value)
    case 'color': {
      const channels = value as [number, number, number, number]
      return `rgba(${channels.map((channel) => channel.toFixed(2)).join(', ')})`
    }
    case 'int':
      return String(Math.round(Number(value)))
    case 'float': {
      const numeric = Number(value)
      const text = Math.abs(numeric) >= 100 ? numeric.toFixed(0) : numeric.toFixed(3).replace(/\.?0+$/, '')
      return param.unit ? `${text} ${param.unit}` : text
    }
    default: {
      const text = String(value)
      return text.length > 40 ? `${text.slice(0, 37)}…` : text
    }
  }
}

export const selectNode = (id: string | null | undefined) => (state: PatchState) =>
  id ? state.nodes.find((node) => node.id === id) : undefined
