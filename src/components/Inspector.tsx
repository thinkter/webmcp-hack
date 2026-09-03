/**
 * Parameter inspector.
 *
 * Entirely generated from the operator declaration: pages, widgets, help text,
 * and modulation state all come from the same `ParamSpec` list the renderer packs
 * into uniforms, so what you see here is exactly what the GPU receives.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, EyeOff, ScreenShare, Trash2 } from 'lucide-react'
import { getOperator } from '../engine/ops'
import { engine } from '../engine/renderer'
import { useEngineStatus, useMediaEntry } from '../hooks/useEngineStatus'
import { resolveParams, usePatchStore } from '../graph/store'
import { paramKeyFromHandle } from '../graph/types'
import { ParamField } from './ParamField'

export function Inspector() {
  const nodes = usePatchStore((state) => state.nodes)
  const edges = usePatchStore((state) => state.edges)
  const selectedNodeIds = usePatchStore((state) => state.selectedNodeIds)
  const selectedEdgeId = usePatchStore((state) => state.selectedEdgeId)
  const setField = usePatchStore((state) => state.setField)
  const deleteNodes = usePatchStore((state) => state.deleteNodes)
  const duplicateNodes = usePatchStore((state) => state.duplicateNodes)
  const disconnect = usePatchStore((state) => state.disconnect)
  const status = useEngineStatus()

  const node = nodes.find((candidate) => candidate.id === selectedNodeIds[0])
  const edge = edges.find((candidate) => candidate.id === selectedEdgeId)
  const spec = getOperator(node?.data.op)

  const media = useMediaEntry(spec?.runtime === 'external' ? node?.id : undefined)

  const modulations = useMemo(() => {
    const map = new Map<string, string>()
    if (!node) return map
    for (const candidate of edges) {
      if (candidate.target !== node.id || !candidate.targetHandle?.startsWith('param:')) continue
      map.set(paramKeyFromHandle(candidate.targetHandle), candidate.source)
    }
    return map
  }, [edges, node])

  const params = useMemo(() => (node ? resolveParams(node) : {}), [node])

  const pages = useMemo(() => {
    if (!spec) return []
    const grouped = new Map<string, typeof spec.params>()
    for (const param of spec.params) {
      if (param.system) continue
      const page = param.page ?? 'Parameters'
      const list = grouped.get(page)
      if (list) list.push(param)
      else grouped.set(page, [param])
    }
    return [...grouped.entries()]
  }, [spec])

  const [activePage, setActivePage] = useState(0)
  useEffect(() => {
    setActivePage(0)
  }, [node?.id])
  const pageIndex = Math.min(activePage, Math.max(0, pages.length - 1))

  if (edge) {
    const source = nodes.find((candidate) => candidate.id === edge.source)
    const target = nodes.find((candidate) => candidate.id === edge.target)
    const isParam = edge.targetHandle?.startsWith('param:')
    return (
      <aside className="inspector">
        <header className="panel-head">
          <div>
            <span>LINK</span>
            <strong>{edge.data?.kind === 'number' ? 'Signal' : 'Texture'}</strong>
          </div>
        </header>
        <div className="inspector-body">
          <div className="link-route">
            <div>
              <span>FROM</span>
              <strong>{source?.data.name}</strong>
            </div>
            <b>→</b>
            <div>
              <span>TO</span>
              <strong>{target?.data.name}</strong>
              <small>
                {isParam ? paramKeyFromHandle(edge.targetHandle!) : (edge.targetHandle ?? 'input')}
              </small>
            </div>
          </div>
          <button type="button" className="danger" onClick={() => disconnect(edge.id)}>
            <Trash2 size={13} />
            Remove link
          </button>
        </div>
      </aside>
    )
  }

  if (!node || !spec) {
    return (
      <aside className="inspector is-empty">
        <header className="panel-head">
          <div>
            <span>INSPECTOR</span>
            <strong>Nothing selected</strong>
          </div>
        </header>
        <div className="inspector-body">
          <p className="muted">
            Select an operator to edit its parameters, or press <kbd>Tab</kbd> to add one.
          </p>
        </div>
      </aside>
    )
  }

  const shaderErrors = status.shaderErrors.get(node.id)
  const nodeIssues = status.issues.filter((issue) => issue.nodeId === node.id)

  return (
    <aside className="inspector">
      <header className="panel-head">
        <div>
          <span>
            {spec.family} · {spec.category}
          </span>
          <input
            className="inspector-name"
            value={node.data.name}
            onChange={(event) => setField(node.id, 'name', event.target.value)}
          />
        </div>
        <div className="inspector-actions">
          <button
            type="button"
            className={node.data.bypass ? 'is-active' : ''}
            title="Bypass: pass the first input straight through"
            onClick={() => setField(node.id, 'bypass', !node.data.bypass)}
          >
            <EyeOff size={13} />
          </button>
          <button type="button" title="Duplicate" onClick={() => duplicateNodes([node.id])}>
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="danger"
            title="Delete"
            onClick={() => deleteNodes([node.id])}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      <div className="inspector-body">
        <p className="inspector-description">
          {spec.description}
          {spec.td ? <em>Modelled on {spec.td}</em> : null}
        </p>

        {shaderErrors?.length ? (
          <div className="notice is-error">
            <AlertTriangle size={13} />
            <div>
              <strong>Shader did not compile</strong>
              {shaderErrors.slice(0, 4).map((error, index) => (
                <p key={index}>
                  {error.line ? <b>line {error.line}: </b> : null}
                  {error.message}
                </p>
              ))}
              <small>The last working version is still rendering.</small>
            </div>
          </div>
        ) : null}

        {nodeIssues.map((issue, index) => (
          <div key={index} className={`notice is-${issue.severity}`}>
            <AlertTriangle size={13} />
            <p>{issue.message}</p>
          </div>
        ))}

        {media ? (
          <div className={`notice ${media.status === 'ready' ? 'is-info' : `is-${media.status === 'loading' ? 'info' : 'warning'}`}`}>
            <div>
              <strong>
                {media.status === 'ready'
                  ? `${media.width} × ${media.height}`
                  : media.status.toUpperCase()}
              </strong>
              <p>{media.error ?? media.detail}</p>
            </div>
          </div>
        ) : null}

        {node.data.op === 'screen' ? (
          <button
            type="button"
            className="wide"
            onClick={() => void engine.requestScreenCapture(node.id)}
          >
            <ScreenShare size={13} />
            Choose a screen or window
          </button>
        ) : null}

        {pages.length > 1 ? (
          <nav className="inspector-pages">
            {pages.map(([page], index) => (
              <button
                key={page}
                type="button"
                className={index === pageIndex ? 'is-active' : ''}
                onClick={() => setActivePage(index)}
              >
                {page}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="param-list">
          {(pages[pageIndex]?.[1] ?? []).map((param) => (
            <ParamField
              key={param.key}
              node={node}
              param={param}
              value={params[param.key]}
              driver={modulations.get(param.key)}
            />
          ))}
        </div>

        <label className="inspector-comment">
          <span>Notes</span>
          <textarea
            rows={2}
            placeholder="What is this operator for?"
            value={String(node.data.comment ?? '')}
            onChange={(event) => setField(node.id, 'comment', event.target.value)}
          />
        </label>
      </div>
    </aside>
  )
}
