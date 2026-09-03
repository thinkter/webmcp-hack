/**
 * React bindings for the non-React subsystems.
 *
 * The engine, audio analysis, MIDI, and networking all run outside React and
 * publish through plain subscribe callbacks. These hooks adapt them without
 * letting 60fps data turn into 60 renders a second: anything that changes every
 * frame is polled on an interval instead of pushed.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { audioEngine } from '../audio/engine'
import { midiEngine } from '../audio/midi'
import { engine, type EngineStatus } from '../engine/renderer'
import { mediaHub } from '../remote/hub'
import { signalClient } from '../remote/signal'

export function useEngineStatus(): EngineStatus {
  return useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => engine.getStatus(),
  )
}

/**
 * Live value of a signal operator. Polled rather than subscribed, because these
 * change every frame and only need to look smooth, not be exact.
 */
export function useSignalValue(nodeId: string | undefined, hz = 20): number {
  const [value, setValue] = useState(0)

  useEffect(() => {
    if (!nodeId) {
      setValue(0)
      return
    }
    let frame = 0
    const interval = window.setInterval(() => {
      const next = engine.signalValue(nodeId)
      // Only re-render when the change is visible at three decimal places.
      setValue((current) => (Math.abs(current - next) > 0.0005 ? next : current))
      frame += 1
    }, 1000 / hz)
    return () => {
      window.clearInterval(interval)
      void frame
    }
  }, [nodeId, hz])

  return value
}

/** Live values for many signal operators at once, for node-card meters. */
export function useSignalValues(nodeIds: string[], hz = 12): Map<string, number> {
  const [values, setValues] = useState<Map<string, number>>(() => new Map())
  const keyRef = useRef(nodeIds.join(','))
  keyRef.current = nodeIds.join(',')

  useEffect(() => {
    const interval = window.setInterval(() => {
      const ids = keyRef.current ? keyRef.current.split(',') : []
      setValues((current) => {
        let changed = current.size !== ids.length
        const next = new Map<string, number>()
        for (const id of ids) {
          const value = engine.signalValue(id)
          next.set(id, value)
          if (!changed && Math.abs((current.get(id) ?? 0) - value) > 0.002) changed = true
        }
        return changed ? next : current
      })
    }, 1000 / hz)
    return () => window.clearInterval(interval)
  }, [hz])

  return values
}

/** Status of the external media backing a source node. */
export function useMediaEntry(nodeId: string | undefined) {
  const [entry, setEntry] = useState<ReturnType<typeof engine.mediaEntry>>(undefined)

  useEffect(() => {
    if (!nodeId) {
      setEntry(undefined)
      return
    }
    const read = () => {
      const next = engine.mediaEntry(nodeId)
      setEntry((current) =>
        current?.status === next?.status && current?.detail === next?.detail && current?.error === next?.error
          ? current
          : next,
      )
    }
    read()
    const interval = window.setInterval(read, 400)
    return () => window.clearInterval(interval)
  }, [nodeId])

  return entry
}

export function useAudioState() {
  const state = useSyncExternalStore(
    (listener) => audioEngine.subscribe(listener),
    () => audioEngine.state,
  )
  const [meters, setMeters] = useState({ level: 0, beat: 0, bpm: 0 })

  useEffect(() => {
    if (state !== 'running') {
      setMeters({ level: 0, beat: 0, bpm: 0 })
      return
    }
    const interval = window.setInterval(() => {
      const frame = audioEngine.frame
      setMeters({
        level: Math.round(frame.level * 1000) / 1000,
        beat: Math.round(frame.beat * 100) / 100,
        bpm: Math.round(frame.bpm),
      })
    }, 66)
    return () => window.clearInterval(interval)
  }, [state])

  return { state, error: audioEngine.error, deviceId: audioEngine.deviceId, ...meters }
}

export function useMidiState() {
  return useSyncExternalStore(
    (listener) => midiEngine.subscribe(listener),
    () => ({ state: midiEngine.state, inputs: midiEngine.inputs, error: midiEngine.error }),
    () => ({ state: 'idle' as const, inputs: [], error: null }),
  )
}

export function useRemoteState() {
  const hub = useSyncExternalStore(
    (listener) => mediaHub.subscribe(listener),
    () => mediaHub.streams,
  )
  const signal = useSyncExternalStore(
    (listener) => signalClient.subscribe(listener),
    () => signalClient.status,
  )
  return { streams: hub, status: mediaHub.status, signalStatus: signal, room: mediaHub.room, error: mediaHub.error }
}

/**
 * Attaches a canvas to the engine for the lifetime of the component.
 * `fps` throttles redraws, which matters for the many small node thumbnails.
 */
export function useSurface(
  ref: React.RefObject<HTMLCanvasElement | null>,
  target: { kind: 'output' | 'node'; nodeId: string },
  options: { fps?: number; enabled?: boolean } = {},
) {
  const { fps, enabled = true } = options
  const kind = target.kind
  const nodeId = target.nodeId

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !enabled) return
    let detach: (() => void) | null = null
    let cancelled = false

    void engine.start().then(() => {
      if (cancelled || !ref.current) return
      detach = engine.attachSurface(
        ref.current,
        kind === 'output' ? { kind: 'output', nodeId } : { kind: 'node', nodeId },
        { fps },
      )
    })

    return () => {
      cancelled = true
      detach?.()
    }
  }, [ref, kind, nodeId, fps, enabled])
}
