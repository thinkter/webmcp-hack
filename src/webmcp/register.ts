import { addEdge } from '@xyflow/react'
import { useGraphStore } from '../graph/store'
import type { GraphNodeData, NodeKind, VisualNode } from '../graph/types'

type Tool = { name:string; description:string; inputSchema?:Record<string,unknown>; annotations?:{readOnlyHint?:boolean}; execute:(input:Record<string,unknown>)=>unknown|Promise<unknown> }
type ModelContext = { registerTool:(tool:Tool,options?:{signal?:AbortSignal})=>Promise<void> }
declare global { interface Document { modelContext?: ModelContext } }
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false})
const text=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value,null,2)}]})
const snapshot=()=>{const {nodes,edges}=useGraphStore.getState();return{nodes:nodes.map(({id,position,data})=>({id,position,...data})),connections:edges.map(({id,source,target})=>({id,source,target}))}}
function createNode(input:Record<string,unknown>){
  const kind=input.kind as NodeKind;if(!['source','effect','output'].includes(kind))throw new Error(`Unsupported node kind: ${kind}`)
  const id=`${kind}-${crypto.randomUUID()}`,count=useGraphStore.getState().nodes.length
  const data:GraphNodeData={label:String(input.label||`New ${kind}`),kind,enabled:true};if(kind==='effect'){data.effect='chromatic';data.intensity=.5}
  const node:VisualNode={id,type:'graphNode',position:{x:100+(count%3)*260,y:100+Math.floor(count/3)*150},data}
  useGraphStore.setState((state)=>({nodes:[...state.nodes,node],selectedNodeId:id}));return node
}
const tools:Tool[]=[
  {name:'inspect_graph',description:'Inspect the complete live visual graph, including nodes, parameters, positions, and connections.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(snapshot())},
  {name:'create_node',description:'Create a source, GPU effect, or output node in the live graph.',inputSchema:schema({kind:{type:'string',enum:['source','effect','output']},label:{type:'string'}},['kind']),execute:(input)=>text({created:createNode(input)})},
  {name:'connect_nodes',description:'Connect the output of one graph node to the input of another.',inputSchema:schema({source:{type:'string'},target:{type:'string'}},['source','target']),execute:({source,target})=>{const state=useGraphStore.getState(),ids=new Set(state.nodes.map(n=>n.id));if(!ids.has(String(source))||!ids.has(String(target)))throw new Error('Source or target node does not exist.');useGraphStore.setState({edges:addEdge({id:`${source}-${target}`,source:String(source),target:String(target),animated:true},state.edges)});return text({connected:{source,target}})}},
  {name:'set_parameter',description:'Set a live node parameter such as effect, intensity, enabled, or label.',inputSchema:schema({node_id:{type:'string'},parameter:{type:'string'},value:{}},['node_id','parameter','value']),execute:({node_id,parameter,value})=>{if(!useGraphStore.getState().nodes.some(n=>n.id===node_id))throw new Error(`Node not found: ${node_id}`);useGraphStore.getState().setNodeParameter(String(node_id),String(parameter),value);return text({updated:{node_id,parameter,value}})}},
  {name:'delete_node',description:'Delete a node and all of its graph connections.',inputSchema:schema({node_id:{type:'string'}},['node_id']),execute:({node_id})=>{useGraphStore.getState().deleteNode(String(node_id));return text({deleted:node_id})}},
  {name:'list_sources',description:'List all available visual source nodes and their live state.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(useGraphStore.getState().nodes.filter(n=>n.data.kind==='source').map(n=>({id:n.id,...n.data})))},
  {name:'list_outputs',description:'List all output nodes and their live state.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(useGraphStore.getState().nodes.filter(n=>n.data.kind==='output').map(n=>({id:n.id,...n.data})))},
]
export function registerWebMCP(){const context=document.modelContext;if(!context)return{supported:false,dispose:()=>undefined};const controller=new AbortController();Promise.all(tools.map(tool=>context.registerTool(tool,{signal:controller.signal}))).catch(error=>console.error('WebMCP registration failed',error));return{supported:true,dispose:()=>controller.abort()}}
