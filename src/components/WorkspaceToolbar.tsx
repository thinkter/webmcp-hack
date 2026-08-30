import { Clipboard, Copy, Download, Pause, Play, Redo2, Save, Undo2, Upload } from 'lucide-react'
import { useRef } from 'react'
import { useGraphStore, type GraphDocument } from '../graph/store'

export function WorkspaceToolbar(){
  const {undo,redo,past,future,copySelection,paste,serialize,loadDocument,playing,setPlaying,fps,setFps,nodes,edges}=useGraphStore()
  const fileRef=useRef<HTMLInputElement>(null)
  const exportGraph=()=>{const blob=new Blob([JSON.stringify(serialize(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='visual-graph.json';link.click();URL.revokeObjectURL(url)}
  const importGraph=async(file:File)=>{loadDocument(JSON.parse(await file.text()) as GraphDocument)}
  return <div className="workspace-toolbar">
    <div className="toolbar-group"><button title="Undo (Ctrl/Cmd+Z)" disabled={!past.length} onClick={undo}><Undo2 size={14}/></button><button title="Redo (Ctrl/Cmd+Shift+Z)" disabled={!future.length} onClick={redo}><Redo2 size={14}/></button></div>
    <div className="toolbar-group"><button title="Copy (Ctrl/Cmd+C)" onClick={copySelection}><Copy size={14}/></button><button title="Paste (Ctrl/Cmd+V)" onClick={paste}><Clipboard size={14}/></button></div>
    <div className="transport"><button className={playing?'playing':''} onClick={()=>setPlaying(!playing)}>{playing?<Pause size={13}/>:<Play size={13}/>}</button><span>{playing?'LIVE':'PAUSED'}</span><select value={fps} onChange={e=>setFps(Number(e.target.value))}><option>24</option><option>30</option><option>60</option></select><small>FPS</small></div>
    <div className="toolbar-spacer"/><span className="graph-stats">{nodes.length} OPS · {edges.length} LINKS</span>
    <div className="toolbar-group"><button title="Export graph" onClick={exportGraph}><Download size={14}/></button><button title="Import graph" onClick={()=>fileRef.current?.click()}><Upload size={14}/></button><button title="Saved locally"><Save size={14}/></button></div>
    <input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={e=>{const file=e.target.files?.[0];if(file)void importGraph(file);e.target.value=''}}/>
  </div>
}
