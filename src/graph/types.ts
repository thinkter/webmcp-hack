import type { Edge, Node, XYPosition } from '@xyflow/react'

/** Every parameter value that can appear in a patch. */
export type ParamValue = number | boolean | string | [number, number, number, number]

export type NodeData = {
  /** Operator id from the catalog. */
  op: string
  /** User-facing name. Defaults to the operator label. */
  name: string
  enabled: boolean
  /** Bypassed filters pass their first input straight through. */
  bypass: boolean
  /** Only parameters that differ from the operator default are stored. */
  params: Record<string, ParamValue>
  comment?: string
  /** React Flow requires node data to be an open record. */
  [key: string]: unknown
}

export type EdgeData = {
  kind: 'texture' | 'number'
  [key: string]: unknown
}

export type PatchNode = Node<NodeData, 'operator'>
export type PatchEdge = Edge<EdgeData>

export type Resolution = { width: number; height: number }

export type PatchDocument = {
  version: 3
  name: string
  resolution: Resolution
  nodes: PatchNode[]
  edges: PatchEdge[]
  savedAt?: number
}

// ------------------------------------------------------------- provenance ----

export type ActorKind = 'human' | 'agent'

export type Actor = {
  id: string
  name: string
  kind: ActorKind
  color: string
}

/**
 * The smallest reversible unit of change.
 *
 * Recording minimal mutations rather than whole-graph snapshots is what makes
 * selective history possible: "undo everything the agent touched in the last two
 * minutes" is just filtering the log and applying inverses, without discarding
 * the edits a human made in between.
 */
export type Mutation =
  | { type: 'addNode'; node: PatchNode }
  | { type: 'removeNode'; node: PatchNode }
  | { type: 'addEdge'; edge: PatchEdge }
  | { type: 'removeEdge'; edge: PatchEdge }
  | {
      type: 'setParam'
      nodeId: string
      key: string
      before: ParamValue | undefined
      after: ParamValue | undefined
    }
  | {
      type: 'setField'
      nodeId: string
      key: 'name' | 'enabled' | 'bypass' | 'comment'
      before: unknown
      after: unknown
    }
  | { type: 'move'; nodeId: string; before: XYPosition; after: XYPosition }
  | {
      type: 'replaceAll'
      before: { nodes: PatchNode[]; edges: PatchEdge[] }
      after: { nodes: PatchNode[]; edges: PatchEdge[] }
    }
  | { type: 'setResolution'; before: Resolution; after: Resolution }
  | { type: 'setName'; before: string; after: string }

export type ChangeKind =
  | 'create'
  | 'delete'
  | 'connect'
  | 'disconnect'
  | 'parameter'
  | 'layout'
  | 'document'
  | 'revert'

export type ChangeRecord = {
  id: string
  at: number
  actor: Actor
  kind: ChangeKind
  /** One-line human summary, also surfaced to agents through WebMCP. */
  label: string
  /** Node ids the change affected, for filtering and highlighting. */
  targets: string[]
  mutations: Mutation[]
}

export type PortRef = {
  nodeId: string
  /** `out`, `in-0`, or `param:<key>`. */
  portId: string
}

/** Parsed form of a target handle id. */
export function parseHandle(handle: string | null | undefined): PortRef['portId'] | null {
  if (!handle) return null
  return handle
}

export const PARAM_HANDLE_PREFIX = 'param:'

export const isParamHandle = (handle: string | null | undefined): boolean =>
  typeof handle === 'string' && handle.startsWith(PARAM_HANDLE_PREFIX)

export const paramKeyFromHandle = (handle: string): string =>
  handle.slice(PARAM_HANDLE_PREFIX.length)

export const paramHandle = (key: string): string => `${PARAM_HANDLE_PREFIX}${key}`
