import { useGraphStore } from '../graph/store'
import { operators } from '../graph/operators'
import { buildExecutionPlan } from '../graph/execution'

type Tool = { name:string; description:string; inputSchema?:Record<string,unknown>; annotations?:{readOnlyHint?:boolean}; execute:(input:Record<string,unknown>)=>unknown|Promise<unknown> }
type ModelContext = { registerTool:(tool:Tool,options?:{signal?:AbortSignal})=>Promise<void> }
declare global { interface Document { modelContext?: ModelContext } }
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false})
const text=(value:unknown)=>({content:[{type:'text',text:JSON.stringify(value,null,2)}]})
const snapshot=()=>{const {nodes,edges}=useGraphStore.getState();return{execution:buildExecutionPlan(nodes,edges),nodes:nodes.map(({id,position,data})=>({id,position,...data})),connections:edges.map(({id,source,target})=>({id,source,target}))}}
function createNode(input:Record<string,unknown>){
  const legacy:Record<string,string>={source:'camera',effect:'glitch',output:'preview'},operatorId=String(input.operator_id||legacy[String(input.kind)]||'')
  if(!operators.some(operator=>operator.id===operatorId))throw new Error(`Unknown operator_id: ${operatorId}`)
  const state=useGraphStore.getState(),id=state.addOperator(operatorId)
  if(input.label)state.setNodeParameter(id,'label',String(input.label))
  return useGraphStore.getState().nodes.find(node=>node.id===id)
}
const tools:Tool[]=[
  {name:'inspect_graph',description:'Inspect the complete live visual graph, including nodes, parameters, positions, and connections.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(snapshot())},
  {name:'list_operators',description:'List every available TOP and CHOP operator with its typed input and output ports.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(operators)},
  {name:'create_node',description:'Create a typed TOP or CHOP operator node. Call list_operators to discover operator_id values.',inputSchema:schema({operator_id:{type:'string'},label:{type:'string'}},['operator_id']),execute:(input)=>text({created:createNode(input)})},
  {name:'connect_nodes',description:'Connect two typed ports. Texture outputs only connect to texture inputs; numeric CHOP outputs connect to numeric inputs or parameters.',inputSchema:schema({source:{type:'string'},source_handle:{type:'string'},target:{type:'string'},target_handle:{type:'string'}},['source','source_handle','target','target_handle']),execute:({source,source_handle,target,target_handle})=>{const state=useGraphStore.getState(),connection={source:String(source),sourceHandle:String(source_handle),target:String(target),targetHandle:String(target_handle)};if(!state.isValidConnection(connection))throw new Error('Invalid connection: ports are incompatible, occupied, or form a self-loop.');state.onConnect(connection);return text({connected:connection})}},
  {name:'set_parameter',description:'Set a live node parameter such as effect, intensity, enabled, or label.',inputSchema:schema({node_id:{type:'string'},parameter:{type:'string'},value:{}},['node_id','parameter','value']),execute:({node_id,parameter,value})=>{if(!useGraphStore.getState().nodes.some(n=>n.id===node_id))throw new Error(`Node not found: ${node_id}`);useGraphStore.getState().setNodeParameter(String(node_id),String(parameter),value);return text({updated:{node_id,parameter,value}})}},
  {name:'delete_node',description:'Delete a node and all of its graph connections.',inputSchema:schema({node_id:{type:'string'}},['node_id']),execute:({node_id})=>{useGraphStore.getState().deleteNode(String(node_id));return text({deleted:node_id})}},
  {name:'list_sources',description:'List all available visual source nodes and their live state.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(useGraphStore.getState().nodes.filter(n=>n.data.kind==='source').map(n=>({id:n.id,...n.data})))},
  {name:'list_outputs',description:'List all output nodes and their live state.',inputSchema:schema({}),annotations:{readOnlyHint:true},execute:()=>text(useGraphStore.getState().nodes.filter(n=>n.data.kind==='output').map(n=>({id:n.id,...n.data})))},
]
export function registerWebMCP(){const context=document.modelContext;if(!context)return{supported:false,toolCount:0,dispose:()=>undefined};const controller=new AbortController();Promise.all(tools.map(tool=>context.registerTool(tool,{signal:controller.signal}))).catch(error=>console.error('WebMCP registration failed',error));return{supported:true,toolCount:tools.length,dispose:()=>controller.abort()}}
