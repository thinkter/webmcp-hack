import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  ViewportPortal,
} from '@xyflow/react'
import { Bot, History, Radio, Sparkles, SlidersHorizontal } from 'lucide-react'
import { HistoryPanel } from './components/HistoryPanel'
import { Inspector } from './components/Inspector'
import { Monitor } from './components/Monitor'
import { OperatorBrowser } from './components/OperatorBrowser'
import { OperatorNode } from './components/OperatorNode'
import { SessionPanel } from './components/SessionPanel'
import { Toolbar } from './components/Toolbar'
import { engine } from './engine/renderer'
import { getOperator } from './engine/ops'
import { usePatchStore } from './graph/store'
import type { PatchDocument } from './graph/types'
import { useEngineStatus } from './hooks/useEngineStatus'
import { useSession } from './collab/useSession'
import {
  getPresence,
  localPresenceActor,
  setLocalCursor,
  setLocalSelection,
  subscribePresence,
} from './collab/presence'
import { registerAgentTools } from './webmcp/register'
import { parseRoomParams } from './remote/links'
import { JoinPage } from './pages/JoinPage'
import { OutputPage } from './pages/OutputPage'

const nodeTypes = { operator: OperatorNode }
const AUTOSAVE_KEY = 'visual-engine:autosave:v3'

type SidePanel = 'inspector' | 'history' | 'session'

function RemoteCursors() {
  const peers = useSyncExternalStore(subscribePresence, getPresence, getPresence)
  const activePeers = peers.filter(
    (peer) => peer.actor.id !== localPresenceActor.id && peer.cursor !== null,
  )
  if (activePeers.length === 0) return null

  return (
    <ViewportPortal>
      {activePeers.map((peer) => (
        <div
          key={peer.actor.id}
          className="remote-cursor"
          style={{
            transform: `translate(${peer.cursor!.x}px, ${peer.cursor!.y}px)`,
          }}
        >
          <svg
            className="remote-cursor-pointer"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
          >
            <path
              d="M0 0L6 14L8.5 8.5L14 6L0 0Z"
              fill={peer.actor.color}
              stroke="#0b0e14"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          <span
            className="remote-cursor-label"
            style={{ backgroundColor: peer.actor.color }}
          >
            {peer.actor.name}
          </span>
        </div>
      ))}
    </ViewportPortal>
  )
}

let autosaveRestored = false

function getAutosaveKey(): string {
  const room = parseRoomParams().room
  return room ? `visual-engine:autosave:room:${room}` : AUTOSAVE_KEY
}

function Workspace() {
  const store = usePatchStore()
  const status = useEngineStatus()
  const session = useSession()
  const { screenToFlowPosition } = useReactFlow()
  const [panel, setPanel] = useState<SidePanel>('inspector')
  const [agentTools, setAgentTools] = useState(0)

  useEffect(() => {
    void engine.start()
    return () => engine.stop()
  }, [])

  // WebMCP is optional: the editor is fully usable without it.
  useEffect(() => {
    const registration = registerAgentTools()
    setAgentTools(registration.toolCount)
    return registration.dispose
  }, [])

  // Autosave, so a refresh mid-session does not lose the patch.
  useEffect(() => {
    if (autosaveRestored) return

    // If joining an invite room, wait until session becomes shared or connection fails
    const isInvite = parseRoomParams().room !== null
    if (isInvite) {
      if (session.status !== 'online' && session.status !== 'error') return
      autosaveRestored = true
      // If shared, adoptRemote already loaded the room's CRDT document
      if (session.shared) return
      // If connection failed, fallback to any cached room autosave
      const roomSaved = localStorage.getItem(getAutosaveKey())
      if (roomSaved) {
        try {
          store.load(JSON.parse(roomSaved) as PatchDocument)
          store.clearHistory()
        } catch {
          localStorage.removeItem(getAutosaveKey())
        }
      }
      return
    }

    autosaveRestored = true
    const saved = localStorage.getItem(AUTOSAVE_KEY)
    if (!saved) return
    try {
      store.load(JSON.parse(saved) as PatchDocument)
      store.clearHistory()
    } catch {
      localStorage.removeItem(AUTOSAVE_KEY)
    }
  }, [store, session.status, session.shared])

  useEffect(() => {
    // Wait until room connection resolves before autosaving
    if (parseRoomParams().room !== null && session.status !== 'online' && session.status !== 'error') return

    const save = () => {
      try {
        localStorage.setItem(getAutosaveKey(), JSON.stringify(store.serialize()))
      } catch {
        // Quota exceeded on a huge patch is not worth interrupting the show.
      }
    }

    const timer = window.setTimeout(save, 600)
    window.addEventListener('beforeunload', save)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('beforeunload', save)
    }
  }, [store.nodes, store.edges, store.name, store.resolution, store, session.status])

  useEffect(() => {
    setLocalSelection(store.selectedNodeIds)
  }, [store.selectedNodeIds])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      const command = event.metaKey || event.ctrlKey

      if (event.key === 'Tab') {
        event.preventDefault()
        store.openLibrary()
      } else if (event.key === 'Escape') {
        store.closeLibrary()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        if (store.selectedEdgeId) store.disconnect(store.selectedEdgeId)
        else if (store.selectedNodeIds.length) store.deleteNodes(store.selectedNodeIds)
      } else if (command && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        store.duplicateNodes(store.selectedNodeIds)
      } else if (command && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        store.copySelection()
      } else if (command && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        store.paste()
      } else if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        store.select(store.nodes.map((node) => node.id))
      } else if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
      } else if (event.key === ' ') {
        event.preventDefault()
        store.setPlaying(!store.playing)
      } else if (event.key.toLowerCase() === 'b' && store.selectedNodeIds.length === 1) {
        const node = store.nodes.find((candidate) => candidate.id === store.selectedNodeIds[0])
        if (node) store.setField(node.id, 'bypass', !node.data.bypass)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={15} />
          </span>
          <div>
            <span className="eyebrow">WEBGPU · WEBMCP · MULTIPLAYER</span>
            <h1>Signal Yard</h1>
          </div>
        </div>

        <div className="topbar-status">
          <span className={`chip state-${status.state}`}>
            <i />
            {status.state === 'running'
              ? `${status.fps} fps`
              : status.state === 'error'
                ? 'GPU offline'
                : 'starting'}
          </span>
          <span className={`chip ${agentTools ? 'is-good' : ''}`}>
            <Bot size={12} />
            {agentTools ? `${agentTools} agent tools` : 'WebMCP unavailable'}
          </span>
          <span className={`chip status-${session.status}`}>
            <Radio size={12} />
            {session.shared ? `${session.peers} in session` : 'solo'}
          </span>
        </div>
      </header>

      <Toolbar />

      <section className="workspace">
        <div className="canvas-panel">
          <ReactFlow
            nodes={store.nodes}
            edges={store.edges}
            nodeTypes={nodeTypes}
            onNodesChange={store.onNodesChange}
            onEdgesChange={store.onEdgesChange}
            onConnect={store.onConnect}
            isValidConnection={store.isValidConnection}
            onNodeClick={(_, node) => {
              store.select([node.id])
              setPanel('inspector')
            }}
            onEdgeClick={(_, edge) => {
              store.selectEdge(edge.id)
              setPanel('inspector')
            }}
            onPaneClick={() => store.select([])}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              const point = 'clientX' in event ? event : null
              store.openLibrary(
                point
                  ? screenToFlowPosition({ x: point.clientX, y: point.clientY })
                  : null,
              )
            }}
            onPointerMove={(event) => {
              setLocalCursor(screenToFlowPosition({ x: event.clientX, y: event.clientY }))
            }}
            onPointerLeave={() => {
              setLocalCursor(null)
            }}
            colorMode="dark"
            fitView
            minZoom={0.18}
            maxZoom={2}
            deleteKeyCode={null}
            multiSelectionKeyCode="Shift"
            selectionOnDrag
            panOnScroll
            snapToGrid
            snapGrid={[16, 16]}
            defaultEdgeOptions={{ animated: true }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#22282b" />
            <MiniMap
              pannable
              zoomable
              maskColor="rgba(4,6,7,0.72)"
              nodeColor={(node) =>
                getOperator(String(node.data.op))?.family === 'CHOP' ? '#69b7ff' : '#b9ff66'
              }
            />
            <Controls showInteractive={false} />
            <RemoteCursors />
          </ReactFlow>
        </div>

        <div className="side">
          <Monitor />
          <nav className="side-tabs">
            <button
              type="button"
              className={panel === 'inspector' ? 'is-active' : ''}
              onClick={() => setPanel('inspector')}
            >
              <SlidersHorizontal size={13} />
              Inspector
            </button>
            <button
              type="button"
              className={panel === 'history' ? 'is-active' : ''}
              onClick={() => setPanel('history')}
            >
              <History size={13} />
              History
            </button>
            <button
              type="button"
              className={panel === 'session' ? 'is-active' : ''}
              onClick={() => setPanel('session')}
            >
              <Radio size={13} />
              Session
            </button>
          </nav>
          <div className="side-panel">
            {panel === 'inspector' ? <Inspector /> : null}
            {panel === 'history' ? <HistoryPanel /> : null}
            {panel === 'session' ? <SessionPanel /> : null}
          </div>
        </div>
      </section>

      <OperatorBrowser />
    </main>
  )
}

/**
 * Routing is deliberately a single switch on the pathname. The phone publisher
 * and the projector display are separate top-level experiences that must load
 * fast and pull in as little as possible, so there is no router dependency.
 */
export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '')

  if (path === '/join') return <JoinPage />
  if (path === '/output') return <OutputPage />

  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  )
}
