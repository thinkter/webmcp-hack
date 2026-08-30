import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { Cpu, Plus, Radio, Sparkles } from 'lucide-react'
import { GraphNode } from './components/GraphNode'
import { Inspector } from './components/Inspector'
import { WebGPUPreview } from './components/WebGPUPreview'
import { useGraphStore } from './graph/store'
const nodeTypes = { graphNode: GraphNode }

function Workspace() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, selectNode, addEffect } = useGraphStore()
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="mark"><Sparkles size={15}/></span><div><span className="eyebrow">WEBMCP × WEBGPU</span><h1>Visual Graph Lab <em>alpha</em></h1></div></div><div className="status"><span><i/>GPU pipeline live</span><span><Radio size={13}/>local graph</span></div></header>
    <section className="workspace">
      <aside className="rail"><button className="active"><Cpu size={18}/></button><button onClick={addEffect}><Plus size={18}/></button><span/></aside>
      <section className="graph-panel"><PanelHeading label="PATCH" title="MAIN COMPOSITION"><button onClick={addEffect}><Plus size={14}/>Add effect</button></PanelHeading>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,n)=>selectNode(n.id)} onPaneClick={()=>selectNode(null)} fitView colorMode="dark" minZoom={.45}><Background color="#262c2a" gap={28}/><MiniMap nodeColor="#b9ff66" maskColor="rgba(4,6,7,.72)"/><Controls showInteractive={false}/></ReactFlow>
      </section>
      <section className="output-panel"><PanelHeading label="OUTPUT" title="PROGRAM MONITOR"><span className="resolution">1280 × 720</span></PanelHeading><WebGPUPreview/><Inspector/></section>
    </section>
  </main>
}
function PanelHeading({label,title,children}:{label:string;title:string;children:React.ReactNode}) { return <div className="panel-heading"><div><span>{label}</span><strong>{title}</strong></div>{children}</div> }
export default function App() { return <ReactFlowProvider><Workspace/></ReactFlowProvider> }
