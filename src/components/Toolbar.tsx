import { useRef } from 'react'
import {
  Clipboard,
  Copy,
  Download,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Redo2,
  Undo2,
  Upload,
} from 'lucide-react'
import { usePatchStore } from '../graph/store'
import type { PatchDocument } from '../graph/types'
import { useEngineStatus } from '../hooks/useEngineStatus'

const RESOLUTIONS: Array<[string, number, number]> = [
  ['720p', 1280, 720],
  ['1080p', 1920, 1080],
  ['1024²', 1024, 1024],
  ['540p', 960, 540],
  ['Square 720', 720, 720],
]

export function Toolbar() {
  const {
    name,
    setName,
    playing,
    setPlaying,
    targetFps,
    setTargetFps,
    resolution,
    setResolution,
    history,
    undone,
    undo,
    redo,
    copySelection,
    paste,
    selectedNodeIds,
    serialize,
    load,
    reset,
    openLibrary,
    nodes,
    edges,
  } = usePatchStore()
  const status = useEngineStatus()
  const fileRef = useRef<HTMLInputElement>(null)

  const exportPatch = () => {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase() || 'patch'}.patch.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const importPatch = async (file: File) => {
    try {
      load(JSON.parse(await file.text()) as PatchDocument)
    } catch (reason) {
      // A bad file should say why rather than silently doing nothing.
      window.alert(reason instanceof Error ? reason.message : 'That file could not be read.')
    }
  }

  return (
    <div className="toolbar">
      <input
        className="toolbar-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Patch name"
      />

      <div className="toolbar-group">
        <button type="button" title="Undo (⌘Z)" disabled={!history.length} onClick={undo}>
          <Undo2 size={14} />
        </button>
        <button type="button" title="Redo (⇧⌘Z)" disabled={!undone.length} onClick={redo}>
          <Redo2 size={14} />
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          title="Copy selection (⌘C)"
          disabled={!selectedNodeIds.length}
          onClick={copySelection}
        >
          <Copy size={14} />
        </button>
        <button type="button" title="Paste (⌘V)" onClick={() => void paste()}>
          <Clipboard size={14} />
        </button>
      </div>

      <div className="toolbar-group">
        <button type="button" className="primary" onClick={() => openLibrary()}>
          <Plus size={14} />
          Add
          <kbd>tab</kbd>
        </button>
      </div>

      <div className="toolbar-group transport">
        <button
          type="button"
          className={playing ? 'is-active' : ''}
          onClick={() => setPlaying(!playing)}
          title={playing ? 'Pause the timeline' : 'Resume the timeline'}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <span className={playing ? 'live' : 'paused'}>{playing ? 'LIVE' : 'HELD'}</span>
        <select
          value={targetFps}
          onChange={(event) => setTargetFps(Number(event.target.value))}
          title="Target frame rate"
        >
          {[15, 24, 30, 60, 120].map((fps) => (
            <option key={fps} value={fps}>
              {fps} fps
            </option>
          ))}
        </select>
        <select
          value={`${resolution.width}x${resolution.height}`}
          onChange={(event) => {
            const [width, height] = event.target.value.split('x').map(Number)
            setResolution({ width, height })
          }}
          title="Render resolution"
        >
          {RESOLUTIONS.map(([label, width, height]) => (
            <option key={label} value={`${width}x${height}`}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <span className="toolbar-spacer" />

      <span className="toolbar-stats">
        <b>{nodes.length}</b> ops · <b>{edges.length}</b> links · <b>{status.executedNodes}</b> cooking
      </span>

      <div className="toolbar-group">
        <button type="button" title="Export patch" onClick={exportPatch}>
          <Download size={14} />
        </button>
        <button type="button" title="Import patch" onClick={() => fileRef.current?.click()}>
          <Upload size={14} />
        </button>
        <button
          type="button"
          title="Reset to the starter patch"
          onClick={() => {
            if (window.confirm('Replace the current patch with the starter patch?')) reset()
          }}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        hidden
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void importPatch(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}
