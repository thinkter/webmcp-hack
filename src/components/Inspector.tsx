import { Copy, EyeOff, Trash2 } from 'lucide-react'
import { getOperatorDefinition, useGraphStore } from '../graph/store'
import type { EffectKind } from '../graph/types'
const effects: EffectKind[] = ['vhs', 'chromatic', 'pixelate', 'kaleidoscope', 'none']
export function Inspector() {
  const { nodes, selectedNodeId, setNodeParameter, setEffect, deleteNode, duplicateNode, toggleBypass } = useGraphStore()
  const node = nodes.find((item) => item.id === selectedNodeId)
  if (!node) return <div className="inspector empty"><span>SELECT A NODE</span><p>Choose a graph node to inspect its live parameters.</p></div>
  const definition=getOperatorDefinition(node)
  return <div className="inspector">
    <div className="inspector-title"><span>INSPECTOR · {node.data.family}</span><strong>{node.data.label}</strong></div>
    <p className="inspector-description">{definition?.description}</p>
    <label><span>Name</span><input value={node.data.label} onChange={(e) => setNodeParameter(node.id, 'label', e.target.value)} /></label>
    {node.data.family === 'TOP' && node.data.category === 'effect' && <>
      <label><span>Shader</span><select value={node.data.effect} onChange={(e) => setEffect(node.id, e.target.value as EffectKind)}>{effects.map((effect) => <option key={effect}>{effect}</option>)}</select></label>
      <label><span>Intensity <b>{Math.round((node.data.intensity ?? 0) * 100)}%</b></span><input type="range" min="0" max="1" step="0.01" value={node.data.intensity ?? 0} onChange={(e) => setNodeParameter(node.id, 'intensity', Number(e.target.value))} /></label>
    </>}
    {node.data.family==='CHOP'&&<>
      <label><span>Value <b>{Number(node.data.value??0).toFixed(2)}</b></span><input type="range" min="0" max="1" step="0.01" value={Number(node.data.value??0)} onChange={e=>setNodeParameter(node.id,'value',Number(e.target.value))}/></label>
      <label><span>Speed <b>{Number(node.data.speed??1).toFixed(1)} Hz</b></span><input type="range" min="0.05" max="8" step="0.05" value={Number(node.data.speed??1)} onChange={e=>setNodeParameter(node.id,'speed',Number(e.target.value))}/></label>
      <label><span>Amplitude <b>{Number(node.data.amplitude??1).toFixed(2)}</b></span><input type="range" min="0" max="1" step="0.01" value={Number(node.data.amplitude??1)} onChange={e=>setNodeParameter(node.id,'amplitude',Number(e.target.value))}/></label>
    </>}
    <label className="toggle-row"><span>Enabled</span><input type="checkbox" checked={node.data.enabled} onChange={(e) => setNodeParameter(node.id, 'enabled', e.target.checked)} /></label>
    <div className="inspector-actions"><button onClick={()=>toggleBypass(node.id)}><EyeOff size={14}/>Bypass</button><button onClick={()=>duplicateNode(node.id)}><Copy size={14}/>Duplicate</button><button className="danger-button" onClick={() => deleteNode(node.id)}><Trash2 size={14} /> Delete</button></div>
  </div>
}
