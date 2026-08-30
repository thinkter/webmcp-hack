import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { EffectKind, VisualEdge, VisualNode } from './types'

const initialNodes: VisualNode[] = [
  { id: 'source-1', type: 'graphNode', position: { x: 40, y: 180 }, data: { label: 'Signal Field', kind: 'source', enabled: true } },
  { id: 'effect-1', type: 'graphNode', position: { x: 330, y: 180 }, data: { label: 'VHS Drift', kind: 'effect', effect: 'vhs', intensity: 0.64, enabled: true } },
  { id: 'output-1', type: 'graphNode', position: { x: 620, y: 180 }, data: { label: 'Program Out', kind: 'output', enabled: true } },
]
const initialEdges: VisualEdge[] = [
  { id: 'source-1-effect-1', source: 'source-1', target: 'effect-1', animated: true },
  { id: 'effect-1-output-1', source: 'effect-1', target: 'output-1', animated: true },
]

type GraphState = {
  nodes: VisualNode[]; edges: VisualEdge[]; selectedNodeId: string | null
  onNodesChange: (changes: NodeChange<VisualNode>[]) => void
  onEdgesChange: (changes: EdgeChange<VisualEdge>[]) => void
  onConnect: (connection: Connection) => void
  selectNode: (id: string | null) => void
  addEffect: () => void
  deleteNode: (id: string) => void
  setNodeParameter: (id: string, parameter: string, value: unknown) => void
  setEffect: (id: string, effect: EffectKind) => void
}

export const useGraphStore = create<GraphState>((set) => ({
  nodes: initialNodes, edges: initialEdges, selectedNodeId: 'effect-1',
  onNodesChange: (changes) => set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) })),
  onEdgesChange: (changes) => set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),
  onConnect: (connection) => set((s) => ({ edges: addEdge({ ...connection, animated: true }, s.edges) })),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  addEffect: () => set((s) => {
    const number = s.nodes.filter((node) => node.data.kind === 'effect').length + 1
    const id = `effect-${crypto.randomUUID()}`
    return { selectedNodeId: id, nodes: [...s.nodes, { id, type: 'graphNode', position: { x: 320, y: 110 + number * 95 }, data: { label: `Effect ${number}`, kind: 'effect', effect: 'chromatic', intensity: 0.5, enabled: true } }] }
  }),
  deleteNode: (id) => set((s) => ({ nodes: s.nodes.filter((n) => n.id !== id), edges: s.edges.filter((e) => e.source !== id && e.target !== id), selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId })),
  setNodeParameter: (id, parameter, value) => set((s) => ({ nodes: s.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, [parameter]: value } } : n) })),
  setEffect: (id, effect) => set((s) => ({ nodes: s.nodes.map((n) => n.id === id ? { ...n, data: { ...n.data, effect } } : n) })),
}))
