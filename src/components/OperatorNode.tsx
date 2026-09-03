/**
 * A node on the canvas.
 *
 * Each texture node renders a live thumbnail of its own output, which is the
 * single biggest thing that makes a patch readable: you can see where an effect
 * chain goes wrong without clicking through to the monitor.
 */

import { memo, useMemo, useRef } from 'react'
import { Handle, Position, useConnection, useStore, type NodeProps } from '@xyflow/react'
import { AlertTriangle, Copy, Eye, EyeOff, Radio, Trash2, Zap } from 'lucide-react'
import { getOperator } from '../engine/ops'
import { useEngineStatus, useMediaEntry, useSignalValue, useSurface } from '../hooks/useEngineStatus'
import { paramValue, usePatchStore } from '../graph/store'
import { paramHandle, type PatchNode } from '../graph/types'

/** Below this zoom a thumbnail is a few pixels and not worth the draw call. */
const THUMBNAIL_ZOOM_THRESHOLD = 0.45

export const OperatorNode = memo(function OperatorNode({ id, data, selected }: NodeProps<PatchNode>) {
  const spec = getOperator(data.op)
  const zoom = useStore((state) => state.transform[2])
  const connection = useConnection()
  const nodes = usePatchStore((state) => state.nodes)
  const edges = usePatchStore((state) => state.edges)
  const setField = usePatchStore((state) => state.setField)
  const deleteNodes = usePatchStore((state) => state.deleteNodes)
  const duplicateNodes = usePatchStore((state) => state.duplicateNodes)
  const status = useEngineStatus()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isTop = spec?.family === 'TOP'
  const showThumbnail = Boolean(isTop) && spec?.runtime !== 'output' && zoom > THUMBNAIL_ZOOM_THRESHOLD && data.enabled

  useSurface(canvasRef, { kind: 'node', nodeId: id }, { fps: 15, enabled: showThumbnail })

  const signalValue = useSignalValue(spec?.family === 'CHOP' ? id : undefined, 15)

  /**
   * While a signal connection is being dragged, every modulatable parameter
   * becomes a visible drop target. The rest of the time only wired parameters
   * are shown, otherwise a node with twenty parameters would be unreadable.
   */
  const draggingSignal = useMemo(() => {
    if (!connection.inProgress) return false
    const source = nodes.find((node) => node.id === connection.fromNode?.id)
    return getOperator(source?.data.op)?.family === 'CHOP'
  }, [connection, nodes])

  const wiredParams = useMemo(() => {
    const wired = new Set<string>()
    for (const edge of edges) {
      if (edge.target !== id || !edge.targetHandle?.startsWith('param:')) continue
      wired.add(edge.targetHandle.slice('param:'.length))
    }
    return wired
  }, [edges, id])

  const paramPorts = useMemo(() => {
    if (!spec) return []
    const modulatable = spec.params.filter((param) => param.modulatable)
    return draggingSignal ? modulatable : modulatable.filter((param) => wiredParams.has(param.key))
  }, [spec, draggingSignal, wiredParams])

  if (!spec) {
    return (
      <article className="node node-missing">
        <strong>Unknown operator</strong>
        <p>{String(data.op)}</p>
      </article>
    )
  }

  const shaderErrors = status.shaderErrors.get(id)
  const issue = status.issues.find((entry) => entry.nodeId === id)
  const problem = shaderErrors?.length
    ? shaderErrors[0].message
    : issue?.severity === 'error'
      ? issue.message
      : null
  const warning = !problem && issue?.severity === 'warning' ? issue.message : null

  return (
    <article
      className={[
        'node',
        `node-${spec.family.toLowerCase()}`,
        `node-${spec.category}`,
        selected ? 'is-selected' : '',
        !data.enabled ? 'is-disabled' : '',
        data.bypass ? 'is-bypassed' : '',
        problem ? 'has-error' : '',
        draggingSignal ? 'is-modulation-target' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {spec.inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          className={`port port-${port.type} ${port.delayed ? 'port-delayed' : ''}`}
          style={{ top: 44 + index * 20 }}
          title={port.delayed ? `${port.label} (previous frame)` : port.label}
        />
      ))}

      <header className="node-head">
        <span className="node-family">{spec.family}</span>
        <strong className="node-name" title={spec.description}>
          {data.name}
        </strong>
        <div className="node-tools">
          <button
            type="button"
            title={data.enabled ? 'Disable' : 'Enable'}
            onClick={(event) => {
              event.stopPropagation()
              setField(id, 'enabled', !data.enabled)
            }}
          >
            {data.enabled ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
          <button
            type="button"
            title="Duplicate"
            onClick={(event) => {
              event.stopPropagation()
              duplicateNodes([id])
            }}
          >
            <Copy size={11} />
          </button>
          <button
            type="button"
            title="Delete"
            onClick={(event) => {
              event.stopPropagation()
              deleteNodes([id])
            }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </header>

      {isTop ? (
        <div className="node-thumb">
          {showThumbnail ? <canvas ref={canvasRef} /> : <div className="node-thumb-idle" />}
          {!data.enabled ? <span className="node-thumb-badge">OFF</span> : null}
          {data.bypass ? <span className="node-thumb-badge">BYPASS</span> : null}
          {spec.runtime === 'external' ? <MediaBadge nodeId={id} /> : null}
        </div>
      ) : (
        <SignalMeter value={signalValue} />
      )}

      {paramPorts.length ? (
        <ul className="node-params">
          {paramPorts.map((param) => (
            <li key={param.key} className={wiredParams.has(param.key) ? 'is-wired' : ''}>
              <Handle
                id={paramHandle(param.key)}
                type="target"
                position={Position.Left}
                className="port port-number port-param"
              />
              <span>{param.label}</span>
              <b>{formatCompact(paramValue({ id, data } as PatchNode, param.key))}</b>
            </li>
          ))}
        </ul>
      ) : null}

      <footer className="node-foot">
        <span className="node-category">{spec.td ?? spec.category}</span>
        {problem ? (
          <span className="node-status is-error" title={problem}>
            <AlertTriangle size={10} />
            error
          </span>
        ) : warning ? (
          <span className="node-status is-warning" title={warning}>
            <AlertTriangle size={10} />
            check
          </span>
        ) : spec.runtime === 'custom' ? (
          <span className="node-status is-live">
            <Zap size={10} />
            wgsl
          </span>
        ) : null}
      </footer>

      {spec.outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          className={`port port-${port.type}`}
          style={{ top: 44 + index * 20 }}
          title={port.label}
        />
      ))}
    </article>
  )
})

function MediaBadge({ nodeId }: { nodeId: string }) {
  const entry = useMediaEntry(nodeId)
  if (!entry || entry.status === 'idle') return null

  if (entry.status === 'ready') {
    return (
      <span className="node-thumb-badge node-thumb-live" title={entry.detail}>
        <Radio size={9} />
        live
      </span>
    )
  }

  return (
    <span
      className={`node-thumb-badge ${entry.status === 'loading' ? '' : 'node-thumb-error'}`}
      title={entry.error ?? entry.detail}
    >
      {entry.status === 'loading' ? 'opening…' : entry.status}
    </span>
  )
}

function SignalMeter({ value }: { value: number }) {
  // Signals routinely exceed 0..1 (a Math CHOP can output anything), so the
  // meter shows the 0..1 window and lets the number carry the rest.
  const clamped = Math.min(1, Math.max(0, value))
  return (
    <div className="node-signal">
      <div className="node-signal-track">
        <div className="node-signal-fill" style={{ width: `${clamped * 100}%` }} />
        <div className="node-signal-tick" style={{ left: '50%' }} />
      </div>
      <b>{value.toFixed(3)}</b>
    </div>
  )
}

function formatCompact(value: unknown): string {
  if (typeof value === 'number') {
    return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2)
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return ''
}
