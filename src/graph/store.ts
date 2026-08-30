import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange, type XYPosition } from '@xyflow/react'
import { create } from 'zustand'
import { operatorMap } from './operators'
import type { EffectKind, NodeKind, OperatorDefinition, VisualEdge, VisualNode } from './types'

function makeNode(operatorId:string,position:XYPosition,id=`${operatorId}-${crypto.randomUUID()}`):VisualNode{
  const definition=operatorMap.get(operatorId);if(!definition)throw new Error(`Unknown operator: ${operatorId}`)
  const kind:NodeKind=definition.category==='output'?'output':definition.category==='source'||definition.category==='generator'?'source':'effect'
  return{id,type:'graphNode',position,data:{label:definition.label,kind,operatorId,family:definition.family,category:definition.category,...definition.defaults}}
}
function freePosition(nodes:VisualNode[]):XYPosition{
  for(let row=0;row<20;row++)for(let column=0;column<5;column++){const candidate={x:40+column*270,y:80+row*170};if(nodes.every(node=>Math.abs(node.position.x-candidate.x)>225||Math.abs(node.position.y-candidate.y)>135))return candidate}
  return{x:40,y:80+nodes.length*170}
}
const initialNodes:VisualNode[]=[
  makeNode('noise',{x:40,y:180},'source-1'),makeNode('glitch',{x:330,y:180},'effect-1'),makeNode('preview',{x:620,y:180},'output-1'),makeNode('lfo',{x:330,y:390},'control-1'),
]
const initialEdges:VisualEdge[]=[
  {id:'source-effect',source:'source-1',sourceHandle:'out',target:'effect-1',targetHandle:'in-0',animated:true,data:{portType:'texture'}},
  {id:'effect-output',source:'effect-1',sourceHandle:'out',target:'output-1',targetHandle:'in-0',animated:true,data:{portType:'texture'}},
  {id:'lfo-intensity',source:'control-1',sourceHandle:'out',target:'effect-1',targetHandle:'param:intensity',animated:true,data:{portType:'number'}},
]
type GraphState={nodes:VisualNode[];edges:VisualEdge[];selectedNodeId:string|null;libraryOpen:boolean
  onNodesChange:(changes:NodeChange<VisualNode>[])=>void;onEdgesChange:(changes:EdgeChange<VisualEdge>[])=>void;onConnect:(connection:Connection)=>void
  isValidConnection:(connection:Connection|VisualEdge)=>boolean;selectNode:(id:string|null)=>void;setLibraryOpen:(open:boolean)=>void;addOperator:(operatorId:string,position?:XYPosition)=>string
  duplicateNode:(id:string)=>void;deleteNode:(id:string)=>void;setNodeParameter:(id:string,parameter:string,value:unknown)=>void;setEffect:(id:string,effect:EffectKind)=>void;toggleBypass:(id:string)=>void}

function portType(node:VisualNode|undefined,handle:string|null|undefined,direction:'input'|'output'){
  if(!node)return undefined;if(handle?.startsWith('param:'))return'number'
  const def=operatorMap.get(String(node.data.operatorId));const ports=direction==='input'?def?.inputs:def?.outputs
  return ports?.find((port)=>port.id===handle)?.type
}
export const useGraphStore=create<GraphState>((set,get)=>({
  nodes:initialNodes,edges:initialEdges,selectedNodeId:'effect-1',libraryOpen:false,
  onNodesChange:(changes)=>set((s)=>({nodes:applyNodeChanges(changes,s.nodes)})),onEdgesChange:(changes)=>set((s)=>({edges:applyEdgeChanges(changes,s.edges)})),
  isValidConnection:(connection)=>{const s=get();if(connection.source===connection.target)return false;const source=s.nodes.find(n=>n.id===connection.source),target=s.nodes.find(n=>n.id===connection.target);return portType(source,connection.sourceHandle,'output')===portType(target,connection.targetHandle,'input')&&!s.edges.some(e=>e.target===connection.target&&e.targetHandle===connection.targetHandle)},
  onConnect:(connection)=>{if(!get().isValidConnection(connection))return;const source=get().nodes.find(n=>n.id===connection.source);set((s)=>({edges:addEdge({...connection,animated:true,data:{portType:portType(source,connection.sourceHandle,'output')}},s.edges)}))},
  selectNode:(selectedNodeId)=>set({selectedNodeId}),setLibraryOpen:(libraryOpen)=>set({libraryOpen}),
  addOperator:(operatorId,position)=>{const id=`${operatorId}-${crypto.randomUUID()}`,node=makeNode(operatorId,position??freePosition(get().nodes),id);set((s)=>({nodes:[...s.nodes,node],selectedNodeId:id,libraryOpen:false}));return id},
  duplicateNode:(id)=>{const original=get().nodes.find(n=>n.id===id);if(!original)return;const copy={...makeNode(String(original.data.operatorId),{x:original.position.x+36,y:original.position.y+36}),data:{...original.data,label:`${original.data.label} Copy`}};set(s=>({nodes:[...s.nodes,copy],selectedNodeId:copy.id}))},
  deleteNode:(id)=>set((s)=>({nodes:s.nodes.filter(n=>n.id!==id),edges:s.edges.filter(e=>e.source!==id&&e.target!==id),selectedNodeId:s.selectedNodeId===id?null:s.selectedNodeId})),
  setNodeParameter:(id,parameter,value)=>set((s)=>({nodes:s.nodes.map(n=>n.id===id?{...n,data:{...n.data,[parameter]:value}}:n)})),
  setEffect:(id,effect)=>get().setNodeParameter(id,'effect',effect),toggleBypass:(id)=>{const node=get().nodes.find(n=>n.id===id);if(node)get().setNodeParameter(id,'bypass',!node.data.bypass)},
}))

export function getOperatorDefinition(node:VisualNode):OperatorDefinition|undefined{return operatorMap.get(String(node.data.operatorId))}
