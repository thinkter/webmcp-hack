import { operatorMap } from './operators'
import type { VisualEdge, VisualNode } from './types'

export type ExecutionPlan={output?:VisualNode;source?:VisualNode;stages:VisualNode[];status:'ready'|'no-output'|'no-input'|'disabled'|'unsupported'|'cycle';message:string}

export function buildExecutionPlan(nodes:VisualNode[],edges:VisualEdge[]):ExecutionPlan{
  const output=nodes.find(node=>node.data.category==='output')
  if(!output)return{stages:[],status:'no-output',message:'No output node exists in this patch.'}
  if(!output.data.enabled)return{output,stages:[],status:'disabled',message:`${output.data.label} is disabled.`}
  let cursor=output.id;const visited=new Set<string>(),stages:VisualNode[]=[]
  while(true){
    if(visited.has(cursor))return{output,stages,status:'cycle',message:'Texture path contains a cycle without an implemented Feedback operator.'}
    visited.add(cursor)
    const edge=edges.find(candidate=>candidate.target===cursor&&candidate.data?.portType==='texture')
    if(!edge)return{output,stages,status:'no-input',message:'Output has no connected texture source.'}
    const node=nodes.find(candidate=>candidate.id===edge.source)
    if(!node)return{output,stages,status:'no-input',message:'Texture link points to a missing node.'}
    if(!node.data.enabled)return{output,source:node,stages,status:'disabled',message:`${node.data.label} is disabled.`}
    if(node.data.category==='effect'&&node.data.bypass){cursor=node.id;continue}
    const definition=operatorMap.get(String(node.data.operatorId))
    if(!definition||definition.runtime!=='ready')return{output,source:node,stages,status:'unsupported',message:`${node.data.label} does not have a runtime implementation yet.`}
    if(node.data.category==='source'||node.data.category==='generator')return{output,source:node,stages,status:'ready',message:`${node.data.label} → ${stages.map(stage=>stage.data.label).join(' → ')||'direct'} → ${output.data.label}`}
    if(node.data.category==='effect'&&!node.data.bypass)stages.unshift(node)
    cursor=node.id
  }
}
