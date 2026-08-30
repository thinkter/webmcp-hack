import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Copy, Eye, EyeOff, MoreHorizontal, Trash2 } from 'lucide-react'
import { getOperatorDefinition, useGraphStore } from '../graph/store'
import type { VisualNode } from '../graph/types'
export function GraphNode({id,data,selected}:NodeProps<VisualNode>){
  const definition=getOperatorDefinition({id,data} as VisualNode);const {deleteNode,duplicateNode,toggleBypass}=useGraphStore()
  const runtimeStatus=!data.enabled?'OFF':definition?.runtime==='planned'?'PLANNED':'COOKING'
  return <article className={`graph-node family-${data.family?.toLowerCase()} ${selected?'selected':''} ${data.bypass?'bypassed':''} ${definition?.runtime==='planned'?'runtime-planned':''}`}>
    {definition?.inputs.map((port,index)=><Handle key={port.id} id={port.id} type="target" position={Position.Left} style={{top:55+index*22}} className={`port-${port.type}`}/>) }
    <div className="node-topline"><i>{data.family}</i><span>{definition?.category}</span><button className="node-menu"><MoreHorizontal size={13}/></button></div>
    <strong>{data.label}</strong><p>{definition?.description}</p>
    <div className="ports-list">{definition?.inputs.map(port=><span key={port.id}><i className={`dot ${port.type}`}/>{port.label}</span>)}</div>
    {data.family==='TOP'&&data.category==='effect'&&<div className="parameter-port"><Handle id="param:intensity" type="target" position={Position.Left} className="port-number"/><span><i className="dot number"/>Intensity</span><b>{Math.round((data.intensity??0)*100)}%</b></div>}
    <div className="node-footer"><span>{runtimeStatus}</span><div><button title="Bypass" onClick={()=>toggleBypass(id)}>{data.bypass?<EyeOff size={12}/>:<Eye size={12}/>}</button><button title="Duplicate" onClick={()=>duplicateNode(id)}><Copy size={12}/></button><button title="Delete" onClick={()=>deleteNode(id)}><Trash2 size={12}/></button></div></div>
    {definition?.outputs.map((port,index)=><Handle key={port.id} id={port.id} type="source" position={Position.Right} style={{top:55+index*22}} className={`port-${port.type}`}/>) }
  </article>
}
