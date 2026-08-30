import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { categories, operators } from '../graph/operators'
import { useGraphStore } from '../graph/store'
export function NodeLibrary(){
  const [query,setQuery]=useState('');const {libraryOpen,setLibraryOpen,addOperator}=useGraphStore()
  const filtered=useMemo(()=>operators.filter(o=>`${o.label} ${o.family} ${o.category}`.toLowerCase().includes(query.toLowerCase())),[query])
  if(!libraryOpen)return null
  return <div className="library-backdrop" onMouseDown={()=>setLibraryOpen(false)}><section className="node-library" onMouseDown={e=>e.stopPropagation()}>
    <header><div><span>OPERATOR BROWSER</span><strong>Add a node</strong></div><button onClick={()=>setLibraryOpen(false)}><X size={16}/></button></header>
    <label className="library-search"><Search size={15}/><input autoFocus placeholder="Search camera, LFO, blend…" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>ESC</kbd></label>
    <div className="library-results">{categories.map(([id,label])=>{const items=filtered.filter(o=>o.category===id);return items.length?<div className="library-category" key={id}><h3>{label}<span>{items.length}</span></h3><div>{items.map(operator=><button className={operator.runtime==='planned'?'planned':''} key={operator.id} onClick={()=>addOperator(operator.id)}><i className={`family-${operator.family.toLowerCase()}`}>{operator.family}</i><span><strong>{operator.label}</strong><small>{operator.description}</small></span><em>{operator.runtime==='ready'?'＋':'PLANNED'}</em></button>)}</div></div>:null})}</div>
  </section></div>
}
