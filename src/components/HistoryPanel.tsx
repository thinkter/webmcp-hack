/**
 * Change history and provenance.
 *
 * Every edit is attributed, so a human and an agent working on the same patch
 * can each see what the other did — and either can be selectively rolled back
 * without discarding the other's work.
 */

import { useMemo, useState } from 'react'
import { Bot, RotateCcw, User } from 'lucide-react'
import { usePatchStore } from '../graph/store'
import type { ChangeRecord } from '../graph/types'

const WINDOWS: Array<[string, number]> = [
  ['30s', 30_000],
  ['2 min', 120_000],
  ['10 min', 600_000],
  ['session', Number.POSITIVE_INFINITY],
]

export function HistoryPanel() {
  const changeLog = usePatchStore((state) => state.changeLog)
  const revertChanges = usePatchStore((state) => state.revertChanges)
  const select = usePatchStore((state) => state.select)
  const [filter, setFilter] = useState<'all' | 'agent' | 'human'>('all')
  const [windowIndex, setWindowIndex] = useState(1)

  const entries = useMemo(() => {
    const list = filter === 'all' ? changeLog : changeLog.filter((record) => record.actor.kind === filter)
    return [...list].reverse().slice(0, 120)
  }, [changeLog, filter])

  const windowMs = WINDOWS[windowIndex][1]
  const agentCount = useMemo(() => {
    const since = Date.now() - windowMs
    return changeLog.filter((record) => record.actor.kind === 'agent' && record.at >= since).length
  }, [changeLog, windowMs])

  return (
    <section className="history">
      <header className="panel-head">
        <div>
          <span>HISTORY</span>
          <strong>{changeLog.length} changes</strong>
        </div>
        <div className="history-filters">
          {(['all', 'human', 'agent'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              onClick={() => setFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </header>

      <div className="history-revert">
        <span>Undo agent edits from the last</span>
        <select value={windowIndex} onChange={(event) => setWindowIndex(Number(event.target.value))}>
          {WINDOWS.map(([label], index) => (
            <option key={label} value={index}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={agentCount === 0}
          onClick={() => {
            const since = Date.now() - windowMs
            revertChanges(
              (record) => record.actor.kind === 'agent' && record.at >= since,
              `Reverted ${agentCount} agent change${agentCount === 1 ? '' : 's'}`,
            )
          }}
        >
          <RotateCcw size={12} />
          {agentCount === 0 ? 'Nothing to undo' : `Revert ${agentCount}`}
        </button>
      </div>

      <ol className="history-list">
        {entries.length === 0 ? (
          <li className="muted history-empty">No changes yet.</li>
        ) : (
          entries.map((record) => <HistoryRow key={record.id} record={record} onSelect={select} />)
        )}
      </ol>
    </section>
  )
}

function HistoryRow({
  record,
  onSelect,
}: {
  record: ChangeRecord
  onSelect: (ids: string[]) => void
}) {
  const isAgent = record.actor.kind === 'agent'
  return (
    <li className={`history-row ${isAgent ? 'is-agent' : ''} kind-${record.kind}`}>
      <span className="history-actor" style={{ color: record.actor.color }} title={record.actor.name}>
        {isAgent ? <Bot size={12} /> : <User size={12} />}
      </span>
      <button
        type="button"
        className="history-label"
        disabled={record.targets.length === 0}
        onClick={() => onSelect(record.targets)}
        title={record.targets.length ? 'Select the affected operators' : undefined}
      >
        {record.label}
      </button>
      <time>{relative(record.at)}</time>
    </li>
  )
}

function relative(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}
