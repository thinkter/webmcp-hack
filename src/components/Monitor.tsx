/**
 * Program monitor.
 *
 * Renders whichever Out operator is selected as the program feed, and doubles
 * as the input surface for the Pointer signal operator so a patch can be played
 * with the mouse.
 */

import { useEffect, useMemo, useRef } from 'react'
import { AlertTriangle, Maximize2, MonitorPlay } from 'lucide-react'
import { engine } from '../engine/renderer'
import { getOperator } from '../engine/ops'
import { useEngineStatus, useSurface } from '../hooks/useEngineStatus'
import { usePatchStore } from '../graph/store'

export function Monitor() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const nodes = usePatchStore((state) => state.nodes)
  const edges = usePatchStore((state) => state.edges)
  const resolution = usePatchStore((state) => state.resolution)
  const select = usePatchStore((state) => state.select)
  const status = useEngineStatus()

  const outputs = useMemo(
    () => nodes.filter((node) => getOperator(node.data.op)?.runtime === 'output'),
    [nodes],
  )
  const programId = outputs.find((node) => node.data.op === 'out')?.id ?? outputs[0]?.id ?? ''

  useSurface(canvasRef, { kind: 'output', nodeId: programId }, { enabled: Boolean(programId) })

  // Pointer position feeds the Pointer CHOP; normalising here means the signal
  // operator does not need to know anything about the DOM.
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return

    const toNormalised = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      return {
        x: (event.clientX - rect.left) / Math.max(1, rect.width),
        y: (event.clientY - rect.top) / Math.max(1, rect.height),
      }
    }

    const onMove = (event: PointerEvent) => {
      const { x, y } = toNormalised(event)
      engine.setPointer(x, y, event.buttons > 0)
    }
    const onDown = (event: PointerEvent) => {
      const { x, y } = toNormalised(event)
      engine.setPointer(x, y, true)
    }
    const onUp = (event: PointerEvent) => {
      const { x, y } = toNormalised(event)
      engine.setPointer(x, y, false)
    }

    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointerleave', onUp)
    return () => {
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointerleave', onUp)
    }
  }, [])

  const feeding = useMemo(() => {
    if (!programId) return null
    const edge = edges.find((candidate) => candidate.target === programId && candidate.targetHandle === 'in-0')
    if (!edge) return null
    return nodes.find((node) => node.id === edge.source)?.data.name ?? null
  }, [edges, nodes, programId])

  const blockingError = status.state === 'error' ? status.error : null
  const graphError = status.issues.find((issue) => issue.severity === 'error')

  return (
    <section className="monitor">
      <header className="panel-head">
        <div>
          <span>PROGRAM</span>
          <strong>{feeding ?? 'No signal'}</strong>
        </div>
        <div className="monitor-head-actions">
          <span className="chip">
            {resolution.width} × {resolution.height}
          </span>
          <button
            type="button"
            title="Fullscreen the monitor"
            onClick={() => void wrapRef.current?.requestFullscreen?.().catch(() => undefined)}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </header>

      <div
        className="monitor-surface"
        ref={wrapRef}
        style={{ aspectRatio: `${resolution.width} / ${resolution.height}` }}
      >
        <canvas ref={canvasRef} aria-label="Program output" />

        {blockingError ? (
          <div className="monitor-overlay is-error">
            <AlertTriangle size={18} />
            <strong>GPU unavailable</strong>
            <p>{blockingError}</p>
            {status.hint ? <small>{status.hint}</small> : null}
          </div>
        ) : !programId ? (
          <div className="monitor-overlay">
            <MonitorPlay size={18} />
            <strong>No output operator</strong>
            <p>Add an Out operator and wire a texture into it.</p>
          </div>
        ) : !feeding ? (
          <div className="monitor-overlay">
            <MonitorPlay size={18} />
            <strong>Nothing connected</strong>
            <p>Wire an operator into {outputs.find((node) => node.id === programId)?.data.name}.</p>
          </div>
        ) : graphError ? (
          <div className="monitor-overlay is-warning">
            <AlertTriangle size={16} />
            <strong>Graph problem</strong>
            <p>{graphError.message}</p>
            {graphError.nodeId ? (
              <button type="button" onClick={() => select([graphError.nodeId!])}>
                Show the operator
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
