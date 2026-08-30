import type { Edge, Node } from '@xyflow/react'
export type NodeKind = 'source' | 'effect' | 'output'
export type EffectKind = 'vhs' | 'pixelate' | 'kaleidoscope' | 'chromatic' | 'none'
export type GraphNodeData = { label: string; kind: NodeKind; effect?: EffectKind; intensity?: number; enabled?: boolean; [key: string]: unknown }
export type VisualNode = Node<GraphNodeData, 'graphNode'>
export type VisualEdge = Edge
