/**
 * Operator browser.
 *
 * Search covers labels, ids, descriptions, keywords, and the TouchDesigner
 * operator each one is modelled on — so someone arriving from TouchDesigner can
 * type "Level TOP" or "Movie File In" and land in the right place.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { CATEGORY_ORDER, searchOperators } from '../engine/ops'
import { usePatchStore } from '../graph/store'

export function OperatorBrowser() {
  const open = usePatchStore((state) => state.libraryOpen)
  const close = usePatchStore((state) => state.closeLibrary)
  const anchor = usePatchStore((state) => state.libraryAnchor)
  const addOperator = usePatchStore((state) => state.addOperator)
  const selectedEdgeId = usePatchStore((state) => state.selectedEdgeId)
  const insertBetween = usePatchStore((state) => state.insertBetween)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const results = useMemo(() => searchOperators(query), [query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    // Focus after the modal paints, otherwise Safari drops the focus call.
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, results.length - 1)))
  }, [results.length])

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const add = (op: string) => {
    // When a link is selected, inserting splices the new operator into it,
    // which is how you actually build a chain rather than rewiring by hand.
    if (selectedEdgeId && insertBetween(selectedEdgeId, op)) {
      close()
      return
    }
    addOperator(op, anchor ?? undefined)
  }

  const grouped = CATEGORY_ORDER.map(
    ([category, label]) =>
      [label, results.filter((operator) => operator.category === category)] as const,
  ).filter(([, items]) => items.length > 0)

  return (
    <div className="browser-backdrop" onMouseDown={close}>
      <section className="browser" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>OPERATORS</span>
            <strong>
              {selectedEdgeId ? 'Insert into the selected link' : 'Add an operator'}
            </strong>
          </div>
          <button type="button" onClick={close} aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <label className="browser-search">
          <Search size={14} />
          <input
            ref={inputRef}
            placeholder="Search camera, blur, feedback, Level TOP, bass…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((current) => Math.min(current + 1, results.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((current) => Math.max(current - 1, 0))
              } else if (event.key === 'Enter' && results[cursor]) {
                event.preventDefault()
                add(results[cursor].id)
              } else if (event.key === 'Escape') {
                close()
              }
            }}
          />
          <span className="browser-count">{results.length}</span>
        </label>

        <div className="browser-results" ref={listRef}>
          {grouped.length === 0 ? (
            <p className="muted browser-empty">
              Nothing matches “{query}”. Every operator in this build is real — if it is not
              listed, it is not implemented.
            </p>
          ) : (
            grouped.map(([label, items]) => (
              <div className="browser-group" key={label}>
                <h3>
                  {label}
                  <span>{items.length}</span>
                </h3>
                <div>
                  {items.map((operator) => {
                    const index = results.indexOf(operator)
                    return (
                      <button
                        key={operator.id}
                        type="button"
                        data-active={index === cursor}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => add(operator.id)}
                      >
                        <i className={`family family-${operator.family.toLowerCase()}`}>
                          {operator.family}
                        </i>
                        <span>
                          <strong>{operator.label}</strong>
                          <small>{operator.description}</small>
                        </span>
                        {operator.td ? <em>{operator.td}</em> : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <footer className="browser-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> add
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </section>
    </div>
  )
}
