/**
 * Parameter editors, generated from the operator declaration.
 *
 * There is no per-operator inspector code anywhere in the app: adding a
 * parameter to an operator is enough to make it appear here, be modulatable,
 * be serialised, and be reachable from WebMCP.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link2, RotateCcw, Upload } from 'lucide-react'
import type { ParamSpec } from '../engine/ops/kit'
import { formatParam, usePatchStore } from '../graph/store'
import { paramHandle, type ParamValue, type PatchNode } from '../graph/types'
import { useSignalValue } from '../hooks/useEngineStatus'

type Props = {
  node: PatchNode
  param: ParamSpec
  value: ParamValue
  /** Node id of the signal operator driving this parameter, when there is one. */
  driver?: string
}

export function ParamField({ node, param, value, driver }: Props) {
  const setParam = usePatchStore((state) => state.setParam)
  const resetParam = usePatchStore((state) => state.resetParam)
  const disconnect = usePatchStore((state) => state.disconnect)
  const edges = usePatchStore((state) => state.edges)
  const overridden = node.data.params[param.key] !== undefined

  const driverValue = useSignalValue(driver)
  const driverEdge = useMemo(
    () =>
      driver
        ? edges.find(
            (edge) => edge.target === node.id && edge.targetHandle === paramHandle(param.key),
          )
        : undefined,
    [driver, edges, node.id, param.key],
  )

  const commit = (next: unknown) => setParam(node.id, param.key, next)

  return (
    <div className={`param ${driver ? 'param-driven' : ''} ${param.system ? 'param-system' : ''}`}>
      <div className="param-head">
        <label htmlFor={`${node.id}-${param.key}`} title={param.help}>
          {param.label}
          {param.unit ? <em>{param.unit}</em> : null}
        </label>
        <div className="param-meta">
          {driver ? (
            <button
              type="button"
              className="param-driver"
              title="Driven by a signal. Click to disconnect."
              onClick={() => driverEdge && disconnect(driverEdge.id)}
            >
              <Link2 size={11} />
              {driverValue.toFixed(3)}
            </button>
          ) : (
            <span className="param-value">{formatParam(param, value)}</span>
          )}
          {overridden && !driver ? (
            <button
              type="button"
              className="param-reset"
              title="Reset to the operator default"
              onClick={() => resetParam(node.id, param.key)}
            >
              <RotateCcw size={11} />
            </button>
          ) : null}
        </div>
      </div>
      <Editor
        id={`${node.id}-${param.key}`}
        param={param}
        value={value}
        disabled={Boolean(driver)}
        onChange={commit}
      />
      {param.help ? <p className="param-help">{param.help}</p> : null}
    </div>
  )
}

type EditorProps = {
  id: string
  param: ParamSpec
  value: ParamValue
  disabled: boolean
  onChange: (next: unknown) => void
}

function Editor({ id, param, value, disabled, onChange }: EditorProps) {
  switch (param.kind) {
    case 'bool':
      return (
        <label className="param-switch">
          <input
            id={id}
            type="checkbox"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span />
        </label>
      )

    case 'menu':
      return (
        <select
          id={id}
          value={Number(value)}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {(param.options ?? []).map((option, index) => (
            <option key={option} value={index}>
              {option}
            </option>
          ))}
        </select>
      )

    case 'float':
    case 'int':
      return <NumberEditor id={id} param={param} value={Number(value)} disabled={disabled} onChange={onChange} />

    case 'color':
      return <ColorEditor id={id} value={value as [number, number, number, number]} disabled={disabled} onChange={onChange} />

    case 'wgsl':
      return <CodeEditor id={id} value={String(value)} onChange={onChange} />

    case 'device':
      return <DeviceEditor id={id} value={String(value)} onChange={onChange} />

    case 'file':
      return <FileEditor id={id} value={String(value)} onChange={onChange} />

    default:
      return String(value).includes('\n') || String(value).length > 48 ? (
        <textarea
          id={id}
          rows={3}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input id={id} type="text" value={String(value)} onChange={(event) => onChange(event.target.value)} />
      )
  }
}

function NumberEditor({
  id,
  param,
  value,
  disabled,
  onChange,
}: {
  id: string
  param: ParamSpec
  value: number
  disabled: boolean
  onChange: (next: number) => void
}) {
  const min = param.min ?? 0
  const max = param.max ?? 1
  const step = param.kind === 'int' ? 1 : (param.step ?? (max - min) / 1000)

  // A log-scaled slider makes frequency and scale controls usable, where the
  // interesting range is bunched near the bottom.
  const toSlider = (raw: number) => {
    if (!param.log || min <= 0) return raw
    const t = Math.log(Math.max(raw, min) / min) / Math.log(max / min)
    return min + t * (max - min)
  }
  const fromSlider = (slider: number) => {
    if (!param.log || min <= 0) return slider
    const t = (slider - min) / (max - min)
    return min * Math.pow(max / min, t)
  }

  const [text, setText] = useState<string | null>(null)

  return (
    <div className="param-number">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={param.log ? (max - min) / 1000 : step}
        value={toSlider(Math.min(max, Math.max(min, value)))}
        disabled={disabled}
        onChange={(event) => onChange(fromSlider(Number(event.target.value)))}
      />
      <input
        className="param-numeric"
        type="number"
        step={step}
        value={text ?? roundForDisplay(value, param)}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => {
          setText(null)
          const parsed = Number(event.target.value)
          if (Number.isFinite(parsed)) onChange(parsed)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setText(null)
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

const roundForDisplay = (value: number, param: ParamSpec): number =>
  param.kind === 'int' ? Math.round(value) : Math.round(value * 1000) / 1000

function ColorEditor({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string
  value: [number, number, number, number]
  disabled: boolean
  onChange: (next: [number, number, number, number]) => void
}) {
  const channels = useMemo<[number, number, number, number]>(
    () => (Array.isArray(value) ? value : [0, 0, 0, 1]),
    [value],
  )
  const hex = useMemo(() => {
    const to = (channel: number) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, '0')
    return `#${to(channels[0])}${to(channels[1])}${to(channels[2])}`
  }, [channels])

  return (
    <div className="param-color">
      <input
        id={id}
        type="color"
        value={hex}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value.slice(1)
          const channel = (index: number) => parseInt(raw.slice(index * 2, index * 2 + 2), 16) / 255
          onChange([channel(0), channel(1), channel(2), channels[3]])
        }}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={channels[3]}
        disabled={disabled}
        title="Alpha"
        onChange={(event) =>
          onChange([channels[0], channels[1], channels[2], Number(event.target.value)])
        }
      />
    </div>
  )
}

function CodeEditor({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const dirty = draft !== value
  useEffect(() => setDraft(value), [value])

  return (
    <div className="param-code">
      <textarea
        id={id}
        spellCheck={false}
        value={draft}
        rows={14}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl/Cmd+Enter recompiles, matching the muscle memory of every
          // live-coding tool. Tab inserts spaces instead of leaving the field.
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            onChange(draft)
          }
          if (event.key === 'Tab') {
            event.preventDefault()
            const target = event.currentTarget
            const start = target.selectionStart
            const next = `${draft.slice(0, start)}  ${draft.slice(target.selectionEnd)}`
            setDraft(next)
            requestAnimationFrame(() => {
              target.selectionStart = start + 2
              target.selectionEnd = start + 2
            })
          }
        }}
      />
      <div className="param-code-actions">
        <button type="button" disabled={!dirty} onClick={() => onChange(draft)}>
          Compile <kbd>⌘↵</kbd>
        </button>
        <button type="button" disabled={!dirty} onClick={() => setDraft(value)}>
          Revert
        </button>
      </div>
    </div>
  )
}

function DeviceEditor({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (next: string) => void
}) {
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return
      const all = await navigator.mediaDevices.enumerateDevices()
      if (cancelled) return
      setDevices(
        all
          .filter((device) => device.kind === 'videoinput' || device.kind === 'audioinput')
          .map((device, index) => ({
            deviceId: device.deviceId,
            // Labels stay empty until permission is granted, so fall back to an
            // index rather than showing a row of blanks.
            label: device.label || `${device.kind === 'videoinput' ? 'Camera' : 'Input'} ${index + 1}`,
          })),
      )
    }
    void load()
    navigator.mediaDevices?.addEventListener?.('devicechange', load)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', load)
    }
  }, [])

  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Default device</option>
      {devices.map((device) => (
        <option key={device.deviceId} value={device.deviceId}>
          {device.label}
        </option>
      ))}
    </select>
  )
}

async function processImageFile(file: File): Promise<string> {
  const nameFragment = `#name=${encodeURIComponent(file.name)}`

  if (file.type === 'image/svg+xml' || (file.size <= 1024 * 1024 && file.type === 'image/gif')) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(`${reader.result as string}${nameFragment}`)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  if (file.size <= 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(`${reader.result as string}${nameFragment}`)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  try {
    const bitmap = await createImageBitmap(file)
    const maxDim = 1920
    let { width, height } = bitmap
    if (width > maxDim || height > maxDim) {
      if (width > height) {
        height = Math.round((height * maxDim) / width)
        width = maxDim
      } else {
        width = Math.round((width * maxDim) / height)
        height = maxDim
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not get 2d canvas context')
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const dataUrl = canvas.toDataURL(mime, 0.85)
    return `${dataUrl}${nameFragment}`
  } catch {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(`${reader.result as string}${nameFragment}`)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }
}

function getFileName(value: string): string {
  if (!value) return 'None'
  if (value.startsWith('data:')) {
    const hashIdx = value.indexOf('#name=')
    if (hashIdx !== -1) {
      try {
        return decodeURIComponent(value.slice(hashIdx + 6))
      } catch {
        return 'Image file'
      }
    }
    const match = value.match(/data:image\/([a-zA-Z0-9]+)/)
    return match ? `Image (${match[1]})` : 'Image file'
  }
  if (value.startsWith('blob:')) return 'Local file'
  return value.split('/').pop() || 'File'
}

function FileEditor({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (next: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const previous = useRef<string | null>(null)

  useEffect(
    () => () => {
      // Object URLs live until revoked; releasing on unmount stops a long
      // session from leaking every clip the user auditioned.
      if (previous.current) URL.revokeObjectURL(previous.current)
    },
    [],
  )

  const name = getFileName(value)

  return (
    <div className="param-file">
      <button type="button" onClick={() => inputRef.current?.click()}>
        <Upload size={12} />
        {name}
      </button>
      <input
        id={id}
        ref={inputRef}
        type="file"
        hidden
        accept="video/*,image/*"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (!file) return
          if (file.type.startsWith('image/')) {
            void processImageFile(file).then((dataUrl) => {
              onChange(dataUrl)
            })
          } else {
            if (previous.current) URL.revokeObjectURL(previous.current)
            const url = URL.createObjectURL(file)
            previous.current = url
            onChange(url)
          }
          event.target.value = ''
        }}
      />
      {value ? (
        <button type="button" className="param-file-clear" onClick={() => onChange('')}>
          Clear
        </button>
      ) : null}
    </div>
  )
}
