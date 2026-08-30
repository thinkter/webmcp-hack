import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange, type XYPosition } from '@xyflow/react'
import { create } from 'zustand'
import { operatorMap } from './operators'
import type { EffectKind, NodeKind, OperatorDefinition, VisualEdge, VisualNode } from './types'

export type GraphDocument={version:1;nodes:VisualNode[];edges:VisualEdge[]}
type Snapshot={nodes:VisualNode[];edges:VisualEdge[]}
const copy=<T,>(value:T):T=>structuredClone(value)
const snapshot=(state:{nodes:VisualNode[];edges:VisualEdge[]}):Snapshot=>copy({nodes:state.nodes,edges:state.edges})

function makeNode(operatorId:string,position:XYPosition,id=`${operatorId}-${crypto.randomUUID()}`):VisualNode{
  const definition=operatorMap.get(operatorId);if(!definition)throw new Error(`Unknown operator: ${operatorId}`)
  const kind:NodeKind=definition.category==='output'?'output':definition.category==='source'||definition.category==='generator'?'source':'effect'
  return{id,type:'graphNode',position,data:{label:definition.label,kind,operatorId,family:definition.family,category:definition.category,...definition.defaults}}
}
function freePosition(nodes:VisualNode[]):XYPosition{for(let row=0;row<20;row++)for(let column=0;column<5;column++){const candidate={x:40+column*270,y:80+row*170};if(nodes.every(node=>Math.abs(node.position.x-candidate.x)>225||Math.abs(node.position.y-candidate.y)>135))return candidate}return{x:40,y:80+nodes.length*170}}
const starterNodes:VisualNode[]=[makeNode('noise',{x:40,y:180},'source-1'),makeNode('glitch',{x:330,y:180},'effect-1'),makeNode('preview',{x:620,y:180},'output-1'),makeNode('lfo',{x:330,y:390},'control-1')]
const starterEdges:VisualEdge[]=[
  {id:'source-effect',source:'source-1',sourceHandle:'out',target:'effect-1',targetHandle:'in-0',animated:true,data:{portType:'texture'}},
  {id:'effect-output',source:'effect-1',sourceHandle:'out',target:'output-1',targetHandle:'in-0',animated:true,data:{portType:'texture'}},
  {id:'lfo-intensity',source:'control-1',sourceHandle:'out',target:'effect-1',targetHandle:'param:intensity',animated:true,data:{portType:'number'}},
]
type Clipboard={nodes:VisualNode[];edges:VisualEdge[]}
const CLIPBOARD_KEY='visual-graph-clipboard'
function readClipboard():Clipboard|null{try{return JSON.parse(localStorage.getItem(CLIPBOARD_KEY)??'null') as Clipboard|null}catch{return null}}
function portType(node:VisualNode|undefined,handle:string|null|undefined,direction:'input'|'output'){if(!node)return undefined;if(handle?.startsWith('param:'))return'number';const def=operatorMap.get(String(node.data.operatorId)),ports=direction==='input'?def?.inputs:def?.outputs;return ports?.find(port=>port.id===handle)?.type}

type GraphState={nodes:VisualNode[];edges:VisualEdge[];selectedNodeId:string|null;selectedEdgeId:string|null;libraryOpen:boolean;past:Snapshot[];future:Snapshot[];playing:boolean;fps:number
  onNodesChange:(changes:NodeChange<VisualNode>[])=>void;onEdgesChange:(changes:EdgeChange<VisualEdge>[])=>void;onConnect:(connection:Connection)=>void;isValidConnection:(connection:Connection|VisualEdge)=>boolean
  checkpoint:()=>void;undo:()=>void;redo:()=>void;selectNode:(id:string|null)=>void;selectEdge:(id:string|null)=>void;deleteSelection:()=>void
  copySelection:()=>void;paste:()=>void;selectAll:()=>void;setLibraryOpen:(open:boolean)=>void;addOperator:(operatorId:string,position?:XYPosition)=>string
  duplicateNode:(id:string)=>void;deleteNode:(id:string)=>void;setNodeParameter:(id:string,parameter:string,value:unknown)=>void;setEffect:(id:string,effect:EffectKind)=>void;toggleBypass:(id:string)=>void
  serialize:()=>GraphDocument;loadDocument:(document:GraphDocument)=>void;resetGraph:()=>void;setPlaying:(playing:boolean)=>void;setFps:(fps:number)=>void}

export const useGraphStore=create<GraphState>((set,get)=>({
  nodes:starterNodes,edges:starterEdges,selectedNodeId:'effect-1',selectedEdgeId:null,libraryOpen:false,past:[],future:[],playing:true,fps:60,
  onNodesChange:(changes)=>set(s=>({nodes:applyNodeChanges(changes,s.nodes)})),onEdgesChange:(changes)=>set(s=>({edges:applyEdgeChanges(changes,s.edges)})),
  isValidConnection:(connection)=>{const s=get();if(connection.source===connection.target)return false;const source=s.nodes.find(n=>n.id===connection.source),target=s.nodes.find(n=>n.id===connection.target);return portType(source,connection.sourceHandle,'output')===portType(target,connection.targetHandle,'input')&&!s.edges.some(e=>e.target===connection.target&&e.targetHandle===connection.targetHandle)},
  checkpoint:()=>set(s=>({past:[...s.past.slice(-49),snapshot(s)],future:[]})),
  onConnect:(connection)=>{if(!get().isValidConnection(connection))return;get().checkpoint();const source=get().nodes.find(n=>n.id===connection.source);set(s=>({edges:addEdge({...connection,animated:true,data:{portType:portType(source,connection.sourceHandle,'output')}},s.edges)}))},
  undo:()=>set(s=>{const previous=s.past.at(-1);return previous?{...copy(previous),past:s.past.slice(0,-1),future:[snapshot(s),...s.future],selectedNodeId:null,selectedEdgeId:null}:s}),
  redo:()=>set(s=>{const next=s.future[0];return next?{...copy(next),past:[...s.past,snapshot(s)],future:s.future.slice(1),selectedNodeId:null,selectedEdgeId:null}:s}),
  selectNode:(id)=>set(s=>({selectedNodeId:id,selectedEdgeId:null,nodes:s.nodes.map(node=>({...node,selected:node.id===id})),edges:s.edges.map(edge=>({...edge,selected:false}))})),
  selectEdge:(id)=>set(s=>({selectedEdgeId:id,selectedNodeId:null,edges:s.edges.map(edge=>({...edge,selected:edge.id===id})),nodes:s.nodes.map(node=>({...node,selected:false}))})),
  deleteSelection:()=>{const s=get(),nodeIds=new Set(s.nodes.filter(node=>node.selected).map(node=>node.id));if(s.selectedNodeId)nodeIds.add(s.selectedNodeId);if(!nodeIds.size&&!s.selectedEdgeId)return;s.checkpoint();set(state=>({nodes:state.nodes.filter(node=>!nodeIds.has(node.id)),edges:state.edges.filter(edge=>edge.id!==state.selectedEdgeId&&!nodeIds.has(edge.source)&&!nodeIds.has(edge.target)),selectedNodeId:null,selectedEdgeId:null}))},
  copySelection:()=>{const s=get(),ids=new Set(s.nodes.filter(node=>node.selected||node.id===s.selectedNodeId).map(node=>node.id));if(!ids.size)return;localStorage.setItem(CLIPBOARD_KEY,JSON.stringify({nodes:s.nodes.filter(node=>ids.has(node.id)),edges:s.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target))}))},
  paste:()=>{const clipboard=readClipboard();if(!clipboard?.nodes.length)return;get().checkpoint();const idMap=new Map(clipboard.nodes.map(node=>[node.id,`${node.data.operatorId}-${crypto.randomUUID()}`]));const nodes=clipboard.nodes.map(node=>({...copy(node),id:idMap.get(node.id)!,position:{x:node.position.x+42,y:node.position.y+42},selected:true}));const edges=clipboard.edges.map(edge=>({...copy(edge),id:crypto.randomUUID(),source:idMap.get(edge.source)!,target:idMap.get(edge.target)!}));set(s=>({nodes:[...s.nodes.map(n=>({...n,selected:false})),...nodes],edges:[...s.edges,...edges],selectedNodeId:nodes[0].id,selectedEdgeId:null}))},
  selectAll:()=>set(s=>({nodes:s.nodes.map(node=>({...node,selected:true})),selectedNodeId:null,selectedEdgeId:null})),
  setLibraryOpen:(libraryOpen)=>set({libraryOpen}),
  addOperator:(operatorId,position)=>{get().checkpoint();const id=`${operatorId}-${crypto.randomUUID()}`,node=makeNode(operatorId,position??freePosition(get().nodes),id);set(s=>({nodes:[...s.nodes.map(n=>({...n,selected:false})),{...node,selected:true}],selectedNodeId:id,selectedEdgeId:null,libraryOpen:false}));return id},
  duplicateNode:(id)=>{const node=get().nodes.find(n=>n.id===id);if(!node)return;get().selectNode(id);get().copySelection();get().paste()},
  deleteNode:(id)=>{get().selectNode(id);get().deleteSelection()},
  setNodeParameter:(id,parameter,value)=>{get().checkpoint();set(s=>({nodes:s.nodes.map(n=>n.id===id?{...n,data:{...n.data,[parameter]:value}}:n)}))},
  setEffect:(id,effect)=>get().setNodeParameter(id,'effect',effect),toggleBypass:(id)=>{const node=get().nodes.find(n=>n.id===id);if(node)get().setNodeParameter(id,'bypass',!node.data.bypass)},
  serialize:()=>({version:1,nodes:copy(get().nodes.map(node=>({...node,selected:false}))),edges:copy(get().edges.map(edge=>({...edge,selected:false})))}),
  loadDocument:(document)=>{if(document.version!==1||!Array.isArray(document.nodes)||!Array.isArray(document.edges))throw new Error('Unsupported graph document.');get().checkpoint();set({nodes:copy(document.nodes),edges:copy(document.edges),selectedNodeId:null,selectedEdgeId:null})},
  resetGraph:()=>{get().checkpoint();set({nodes:copy(starterNodes),edges:copy(starterEdges),selectedNodeId:null,selectedEdgeId:null})},setPlaying:(playing)=>set({playing}),setFps:(fps)=>set({fps}),
}))
export function getOperatorDefinition(node:VisualNode):OperatorDefinition|undefined{return operatorMap.get(String(node.data.operatorId))}
