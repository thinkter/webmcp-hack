import { Trash2 } from 'lucide-react'
import { useGraphStore } from '../graph/store'
import type { EffectKind } from '../graph/types'
const effects: EffectKind[] = ['vhs', 'chromatic', 'pixelate', 'kaleidoscope', 'none']
export function Inspector() {
  const { nodes, selectedNodeId, setNodeParameter, setEffect, deleteNode } = useGraphStore()
  const node = nodes.find((item) => item.id === selectedNodeId)
  if (!node) return <div className="inspector empty"><span>SELECT A NODE</span><p>Choose a graph node to inspect its live parameters.</p></div>
  return <div className="inspector">
    <div className="inspector-title"><span>INSPECTOR</span><strong>{node.data.label}</strong></div>
    <label><span>Name</span><input value={node.data.label} onChange={(e) => setNodeParameter(node.id, 'label', e.target.value)} /></label>
    {node.data.kind === 'effect' && <>
      <label><span>Shader</span><select value={node.data.effect} onChange={(e) => setEffect(node.id, e.target.value as EffectKind)}>{effects.map((effect) => <option key={effect}>{effect}</option>)}</select></label>
      <label><span>Intensity <b>{Math.round((node.data.intensity ?? 0) * 100)}%</b></span><input type="range" min="0" max="1" step="0.01" value={node.data.intensity ?? 0} onChange={(e) => setNodeParameter(node.id, 'intensity', Number(e.target.value))} /></label>
    </>}
    <label className="toggle-row"><span>Enabled</span><input type="checkbox" checked={node.data.enabled} onChange={(e) => setNodeParameter(node.id, 'enabled', e.target.checked)} /></label>
    {node.data.kind === 'effect' && <button className="danger-button" onClick={() => deleteNode(node.id)}><Trash2 size={14} /> Delete node</button>}
  </div>
}
