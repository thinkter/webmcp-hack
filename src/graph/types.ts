import type { Edge, Node } from '@xyflow/react'
export type NodeKind = 'source' | 'effect' | 'output'
export type EffectKind = 'vhs' | 'pixelate' | 'kaleidoscope' | 'chromatic' | 'none'
export type PortType='texture'|'number'
export type OperatorFamily='TOP'|'CHOP'
export type OperatorCategory='source'|'generator'|'effect'|'composite'|'control'|'audio'|'output'
export type PortDefinition={id:string;label:string;type:PortType}
export type OperatorDefinition={id:string;label:string;family:OperatorFamily;category:OperatorCategory;description:string;inputs:PortDefinition[];outputs:PortDefinition[];defaults:Record<string,unknown>}
export type GraphNodeData = { label: string; kind: NodeKind; operatorId?:string; family?:OperatorFamily; category?:OperatorCategory; effect?: EffectKind; intensity?: number; enabled?: boolean; bypass?:boolean; value?:number; speed?:number; amplitude?:number; [key: string]: unknown }
export type VisualNode = Node<GraphNodeData, 'graphNode'>
export type VisualEdge = Edge
