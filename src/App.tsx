import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { Cpu, Plus, Radio, Sparkles } from 'lucide-react'
import { GraphNode } from './components/GraphNode'
import { Inspector } from './components/Inspector'
import { NodeLibrary } from './components/NodeLibrary'
import { WebGPUPreview } from './components/WebGPUPreview'
import { WorkspaceToolbar } from './components/WorkspaceToolbar'
import { useGraphStore, type GraphDocument } from './graph/store'
import { registerWebMCP } from './webmcp/register'
const nodeTypes = { graphNode: GraphNode }

function Workspace() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, isValidConnection, checkpoint, selectNode, selectEdge, deleteSelection, copySelection, paste, selectAll, undo, redo, selectedNodeId, duplicateNode, setLibraryOpen, serialize, loadDocument } = useGraphStore()
  const [webMcpSupported, setWebMcpSupported] = useState(false)
  useEffect(() => { const registration = registerWebMCP(); setWebMcpSupported(registration.supported); return registration.dispose }, [])
  useEffect(()=>{const saved=localStorage.getItem('visual-graph-autosave');if(saved)try{loadDocument(JSON.parse(saved) as GraphDocument)}catch{localStorage.removeItem('visual-graph-autosave')}},[loadDocument])
  useEffect(()=>{const timer=setTimeout(()=>localStorage.setItem('visual-graph-autosave',JSON.stringify(serialize())),250);return()=>clearTimeout(timer)},[nodes,edges,serialize])
  useEffect(()=>{const onKey=(event:KeyboardEvent)=>{if((event.target as HTMLElement).matches('input, textarea, select'))return;const command=event.metaKey||event.ctrlKey;if(event.key==='Tab'){event.preventDefault();setLibraryOpen(true)}else if(event.key==='Escape')setLibraryOpen(false);else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();deleteSelection()}else if(command&&event.key.toLowerCase()==='d'&&selectedNodeId){event.preventDefault();duplicateNode(selectedNodeId)}else if(command&&event.key.toLowerCase()==='c'){event.preventDefault();copySelection()}else if(command&&event.key.toLowerCase()==='v'){event.preventDefault();paste()}else if(command&&event.key.toLowerCase()==='a'){event.preventDefault();selectAll()}else if(command&&event.key.toLowerCase()==='z'){event.preventDefault();if(event.shiftKey)redo();else undo()}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[copySelection,deleteSelection,duplicateNode,paste,redo,selectAll,selectedNodeId,setLibraryOpen,undo])
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="mark"><Sparkles size={15}/></span><div><span className="eyebrow">WEBMCP × WEBGPU</span><h1>Visual Graph Lab <em>alpha</em></h1></div></div><div className="status"><span><i/>GPU pipeline live</span><span><Radio size={13}/>{webMcpSupported?'8 tools exposed':'WebMCP unavailable'}</span></div></header>
    <WorkspaceToolbar/><section className="workspace">
      <aside className="rail"><button className="active"><Cpu size={18}/></button><button onClick={()=>setLibraryOpen(true)}><Plus size={18}/></button><span/></aside>
      <section className="graph-panel"><PanelHeading label="PATCH" title="MAIN COMPOSITION"><button onClick={()=>setLibraryOpen(true)}><Plus size={14}/>Add operator <kbd>TAB</kbd></button></PanelHeading>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection} onNodeDragStart={checkpoint} onNodeClick={(_,n)=>selectNode(n.id)} onEdgeClick={(_,edge)=>selectEdge(edge.id)} onPaneClick={()=>selectNode(null)} fitView colorMode="dark" minZoom={.25} maxZoom={1.8} deleteKeyCode={null} snapToGrid snapGrid={[14,14]} selectionOnDrag panOnScroll multiSelectionKeyCode="Shift"><Background color="#262c2a" gap={28}/><MiniMap nodeColor={node=>node.data.family==='CHOP'?'#69b7ff':'#b9ff66'} maskColor="rgba(4,6,7,.72)"/><Controls showInteractive={false}/></ReactFlow>
      </section>
      <section className="output-panel"><PanelHeading label="OUTPUT" title="PROGRAM MONITOR"><span className="resolution">1280 × 720</span></PanelHeading><WebGPUPreview/><Inspector/></section>
    </section><NodeLibrary/>
  </main>
}
function PanelHeading({label,title,children}:{label:string;title:string;children:React.ReactNode}) { return <div className="panel-heading"><div><span>{label}</span><strong>{title}</strong></div>{children}</div> }
export default function App() { return <ReactFlowProvider><Workspace/></ReactFlowProvider> }
