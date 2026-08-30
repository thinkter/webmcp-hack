import { Handle, Position, type NodeProps } from '@xyflow/react'
import { CircleDot, MonitorUp, SlidersHorizontal, Waves } from 'lucide-react'
import type { VisualNode } from '../graph/types'
const icons = { source: Waves, effect: SlidersHorizontal, output: MonitorUp }
export function GraphNode({ data, selected }: NodeProps<VisualNode>) {
  const Icon = icons[data.kind]
  return <article className={`graph-node ${selected ? 'selected' : ''}`}>
    {data.kind !== 'source' && <Handle type="target" position={Position.Left} />}
    <div className="node-topline"><Icon size={15} /><span>{data.kind}</span><CircleDot size={10} /></div>
    <strong>{data.label}</strong>
    <div className="node-meta"><span>{data.effect ?? (data.kind === 'source' ? 'procedural' : 'display')}</span><b>{data.intensity == null ? 'LIVE' : `${Math.round(data.intensity * 100)}%`}</b></div>
    {data.kind !== 'output' && <Handle type="source" position={Position.Right} />}
  </article>
}
