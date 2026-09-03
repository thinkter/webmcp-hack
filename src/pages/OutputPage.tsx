/**
 * `/output?room=ABC&slot=main` — the projector display.
 *
 * This is not a video receiver. It joins the same collaborative session as the
 * editor, so it holds a live copy of the graph, and re-renders it locally on its
 * own GPU: a projector laptop with a decent card produces a clean 60fps image
 * with no encoder artefacts and no latency beyond one frame of CRDT lag.
 *
 * Everything on screen is therefore either the picture or an apology. The
 * overlay fades out after three seconds of stillness, the cursor with it, and
 * every failure state explains itself in text large enough to read from the back
 * of the room — including which output slots *do* exist, because "slot not
 * found" with no list is a dead end when the laptop is across the venue.
 *
 * When the requested slot does not exist, this page renders whatever output it
 * can find and says so in the overlay. A projector showing something beats a
 * projector showing an error.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Cable, Maximize, Minimize, Monitor, RefreshCw } from 'lucide-react'
import { useSession } from '../collab/useSession'
import { getOperator } from '../engine/ops'
import { engine } from '../engine/renderer'
import { resolveParams, usePatchStore } from '../graph/store'
import type { PatchEdge, PatchNode } from '../graph/types'
import { useEngineStatus, useSurface } from '../hooks/useEngineStatus'
import { mediaHub } from '../remote/hub'
import { parseRoomParams } from '../remote/links'
import './pages.css'

/** How long the room stares at a still projection before the chrome disappears. */
const IDLE_MS = 3000

const subscribeHub = (listener: () => void): (() => void) => mediaHub.subscribe(listener)

// ------------------------------------------------------------ output pick ----

type OutputEntry = {
  id: string
  op: string
  /** The node's name in the patch. */
  name: string
  /** `remote-out`'s display channel, or null for a plain `out`. */
  slot: string | null
}

type Choice = {
  node: OutputEntry | null
  /**
   * How we got here, which is what the overlay reports:
   * - `exact`    a `remote-out` whose slot matches
   * - `named`    an output operator whose name matches the slot
   * - `only`     no slot was asked for, so the program output was used
   * - `fallback` the slot does not exist; showing something anyway
   * - `none`     this patch has no output operator at all
   */
  reason: 'exact' | 'named' | 'only' | 'fallback' | 'none'
  outputs: OutputEntry[]
  slots: string[]
}

const paramText = (node: PatchNode, key: string): string => {
  const value = resolveParams(node)[key]
  return typeof value === 'string' ? value.trim() : ''
}

const chooseOutput = (nodes: PatchNode[], wanted: string | null): Choice => {
  const outputs: OutputEntry[] = nodes
    .filter((node) => getOperator(node.data.op)?.runtime === 'output')
    .map((node) => ({
      id: node.id,
      op: node.data.op,
      name: node.data.name.length > 0 ? node.data.name : (getOperator(node.data.op)?.label ?? node.data.op),
      slot: node.data.op === 'remote-out' ? paramText(node, 'slot') : null,
    }))

  const slots = outputs
    .map((entry) => entry.slot)
    .filter((slot): slot is string => slot !== null && slot.length > 0)

  // Prefer the program output when nothing else decides it, matching the
  // editor's own monitor.
  const program = outputs.find((entry) => entry.op === 'out') ?? outputs[0] ?? null

  if (outputs.length === 0) return { node: null, reason: 'none', outputs, slots }

  const target = wanted === null ? '' : wanted.trim().toLowerCase()
  if (target.length === 0) return { node: program, reason: 'only', outputs, slots }

  const exact = outputs.find((entry) => entry.slot !== null && entry.slot.toLowerCase() === target)
  if (exact !== undefined) return { node: exact, reason: 'exact', outputs, slots }

  // A `?slot=` may also name a plain `out` operator — by its node name, or by
  // its id, which is what an agent or a deep link is most likely to have.
  const named = nodes
    .filter((node) => getOperator(node.data.op)?.runtime === 'output')
    .find(
      (node) =>
        node.id.toLowerCase() === target ||
        node.data.name.trim().toLowerCase() === target ||
        paramText(node, 'name').toLowerCase() === target,
    )
  if (named !== undefined) {
    const entry = outputs.find((candidate) => candidate.id === named.id)
    if (entry !== undefined) return { node: entry, reason: 'named', outputs, slots }
  }

  return { node: program, reason: 'fallback', outputs, slots }
}

const isWired = (edges: PatchEdge[], nodeId: string): boolean =>
  edges.some(
    (edge) =>
      edge.target === nodeId &&
      (edge.targetHandle === null || edge.targetHandle === undefined || edge.targetHandle.startsWith('in')),
  )

/**
 * Same feature-detected wake lock as the phone publisher, and for the same
 * reason: a display that goes to sleep halfway through a set is useless. The two
 * pages deliberately do not share a module so that neither can break the other.
 */
const wakeLockApi = (): WakeLock | null => {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null
  const api: WakeLock | undefined = navigator.wakeLock
  return api !== undefined && typeof api.request === 'function' ? api : null
}

// ------------------------------------------------------------------- page ----

export function OutputPage() {
  const session = useSession()
  const [params] = useState(() => parseRoomParams())
  const nodes = usePatchStore((state) => state.nodes)
  const edges = usePatchStore((state) => state.edges)
  const resolution = usePatchStore((state) => state.resolution)
  const status = useEngineStatus()
  const remoteStreams = useSyncExternalStore(subscribeHub, () => mediaHub.streams)

  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wakeRef = useRef<WakeLockSentinel | null>(null)
  const idleTimer = useRef<number | null>(null)

  const [uiVisible, setUiVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)

  const room = params.room
  const slot = params.slot

  const choice = useMemo(() => chooseOutput(nodes, slot), [nodes, slot])
  const nodeId = choice.node?.id ?? ''
  const wired = nodeId.length > 0 && isWired(edges, nodeId)

  // The engine is also started by `useSurface`, but a display with no matching
  // output never attaches a surface, and this screen still needs WebGPU status
  // resolved so it can explain *why* there is no picture.
  //
  useEffect(() => {
    void engine.start()
    return () => engine.stop()
  }, [])

  useSurface(canvasRef, { kind: 'output', nodeId }, { enabled: nodeId.length > 0 })

  /**
   * Remote camera nodes only render if this client is receiving those streams.
   * The hub's publisher side offers to `editor` peers only, so a display that
   * re-renders the graph — as this one does — has to join as an editor to see
   * them. Gated on the patch actually using a camera, so an ordinary projector
   * never costs the phone a second connection or a second copy of its uplink.
   */
  const needsCameras = useMemo(() => nodes.some((node) => node.data.op === 'remote-in'), [nodes])
  const cameraSlots = useMemo(
    () =>
      nodes
        .filter((node) => node.data.op === 'remote-in')
        .map((node) => paramText(node, 'slot'))
        .filter((value) => value.length > 0),
    [nodes],
  )

  useEffect(() => {
    if (room === null || !needsCameras) return
    mediaHub.joinAsEditor(room)
    return () => mediaHub.leave()
  }, [room, needsCameras])

  // -- wake lock ------------------------------------------------------------

  useEffect(() => {
    const api = wakeLockApi()
    if (api === null) return

    let disposed = false
    const take = (): void => {
      const held = wakeRef.current
      if (disposed || (held !== null && !held.released)) return
      void api
        .request('screen')
        .then((sentinel) => {
          if (disposed) {
            void sentinel.release().catch(() => undefined)
            return
          }
          wakeRef.current = sentinel
        })
        .catch(() => undefined)
    }

    // A hidden document cannot hold a lock, and an existing lock is dropped when
    // the page is hidden, so it has to be re-taken on the way back.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') take()
    }

    take()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      const sentinel = wakeRef.current
      wakeRef.current = null
      if (sentinel !== null && !sentinel.released) void sentinel.release().catch(() => undefined)
    }
  }, [])

  // -- idle chrome ----------------------------------------------------------

  useEffect(() => {
    const bump = (): void => {
      setUiVisible(true)
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => setUiVisible(false), IDLE_MS)
    }

    const types = ['pointermove', 'pointerdown', 'touchstart', 'keydown', 'wheel'] as const
    for (const type of types) window.addEventListener(type, bump, { passive: true })
    bump()

    return () => {
      for (const type of types) window.removeEventListener(type, bump)
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
  }, [])

  // -- fullscreen -----------------------------------------------------------

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onChange)
    onChange()
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback((): void => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    const root = rootRef.current
    // Absent in an iframe without `allow="fullscreen"`, and on iOS Safari for
    // non-video elements. Failing silently is correct: the page is already
    // filling the viewport, fullscreen only removes the browser chrome.
    if (root === null || typeof root.requestFullscreen !== 'function') return
    void root.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        toggleFullscreen()
      } else if (event.key === 'Escape' && document.fullscreenElement !== null) {
        // Browsers already exit on Escape; this covers the case where the page
        // was put into fullscreen by other means (kiosk switches, extensions).
        void document.exitFullscreen().catch(() => undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen])

  // -- what to say ----------------------------------------------------------

  const missingCameras = cameraSlots.filter((name) => !remoteStreams.has(name))

  // Is there anything real on the canvas right now? If there is, a status card
  // is information rather than an emergency, and it hides with the rest of the
  // chrome instead of sitting on top of the projection all night.
  const hasPicture = status.state === 'running' && nodeId.length > 0 && wired

  const card = ((): Card | null => {
    if (status.state === 'error') {
      return {
        icon: 'error',
        title: 'This machine cannot render the graph',
        body: status.error ?? 'WebGPU could not be initialised.',
        hint:
          status.hint ??
          'The projector needs a WebGPU-capable browser: Chrome or Edge 113+, or Safari 18+. Chrome on Linux may also need --enable-unsafe-webgpu.',
      }
    }

    if (room === null) {
      return {
        icon: 'missing',
        title: 'This link has no room',
        body:
          'A display has to be told which session to join. Add ?room=CODE to the address — the editor\'s Session panel prints the code and a QR link with it already filled in.',
        hint: 'Until then this screen renders whatever patch happens to be in this browser.',
      }
    }

    if (session.status === 'error') {
      return {
        icon: 'error',
        title: `Could not join room ${session.room}`,
        body: session.error ?? 'The collaboration server refused the connection.',
        hint: 'Check that the room server is running and that this machine can reach the editor\'s address.',
        transient: hasPicture,
      }
    }

    if (session.status === 'connecting') {
      return {
        icon: 'wait',
        title: `Joining room ${session.room}…`,
        body: 'Waiting for the graph to arrive from the editor.',
        hint:
          choice.node !== null
            ? `Showing this machine's local patch (“${choice.node.name}”) in the meantime.`
            : undefined,
        transient: hasPicture,
      }
    }

    if (choice.reason === 'none') {
      return {
        icon: 'missing',
        title: 'This patch has no output',
        body:
          'The graph arrived, but it contains no Out or Remote Out operator, so there is nothing for a display to subscribe to.',
        hint: `Add a Remote Out operator in the editor and set its Slot to “${slot ?? 'main'}”.`,
      }
    }

    if (!wired && choice.node !== null) {
      return {
        icon: 'plug',
        title: `Nothing is wired into ${choice.node.name}`,
        body: 'The output operator exists and this display is subscribed to it, but its texture input is empty.',
        hint: 'Connect an operator to it in the editor and the picture appears here immediately.',
        slots: choice.slots,
      }
    }

    return null
  })()

  const sessionTone: PillTone =
    session.status === 'online' ? 'live' : session.status === 'error' ? 'error' : 'connecting'

  // Aspect ratio comes from the graph, not the display, so the projection is
  // letterboxed rather than stretched. `dvh` is set inline; `pages.css` carries
  // the `vh` fallback for engines that drop the inline declaration.
  const ratio = resolution.width / Math.max(1, resolution.height)
  const frameStyle = {
    '--vjp-ar': `${resolution.width} / ${resolution.height}`,
    aspectRatio: `${resolution.width} / ${resolution.height}`,
    width: `min(100vw, calc(100dvh * ${ratio.toFixed(5)}))`,
  } as React.CSSProperties

  return (
    <div ref={rootRef} className={`vjp vjp-output${uiVisible ? '' : ' is-idle'}`}>
      <div className="vjp-output-frame" style={frameStyle}>
        {nodeId.length > 0 ? <canvas ref={canvasRef} aria-label="Program output" /> : null}

        {card !== null ? <StatusCard {...card} hidden={card.transient === true && !uiVisible} /> : null}

        <div className={`vjp-output-overlay${uiVisible ? '' : ' is-hidden'}`}>
          <span className={`vjp-pill is-${sessionTone}`}>
            <i />
            room {room ?? session.room}
          </span>

          <span className="vjp-pill is-quiet">
            slot {slot ?? '—'}
            {choice.node !== null ? ` → ${choice.node.name}` : ''}
          </span>

          {choice.reason === 'fallback' ? (
            <span className="vjp-pill is-error">
              no slot “{slot}” ·{' '}
              {choice.slots.length > 0
                ? `available: ${choice.slots.join(', ')}`
                : 'this patch has no Remote Out slots'}
            </span>
          ) : null}

          {choice.reason === 'named' ? <span className="vjp-pill is-quiet">matched by name</span> : null}

          <span className="vjp-pill is-quiet">
            {status.state === 'running' ? `${status.fps} fps` : `gpu ${status.state}`}
          </span>

          <span className="vjp-pill is-quiet">
            {resolution.width} × {resolution.height}
          </span>

          <span className={`vjp-pill is-${sessionTone}`}>
            link {session.status}
            {session.peers > 1 ? ` · ${session.peers}` : ''}
          </span>

          {cameraSlots.length > 0 ? (
            <span className={`vjp-pill is-${missingCameras.length > 0 ? 'connecting' : 'live'}`}>
              cameras {cameraSlots.length - missingCameras.length}/{cameraSlots.length}
            </span>
          ) : null}

          <span className="vjp-spacer" />

          <span className="vjp-pill is-quiet">
            <kbd>F</kbd> fullscreen
          </span>

          <button
            type="button"
            className="vjp-btn vjp-btn-small"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Leave fullscreen' : 'Go fullscreen'}
          >
            {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            {fullscreen ? 'Exit' : 'Fullscreen'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- card ----

type PillTone = 'live' | 'connecting' | 'error'

type Card = {
  icon: 'error' | 'wait' | 'plug' | 'missing'
  title: string
  body: string
  hint?: string
  slots?: string[]
  /** Fades out with the rest of the chrome instead of covering the projection. */
  transient?: boolean
}

function StatusCard({ icon, title, body, hint, slots, hidden }: Card & { hidden: boolean }) {
  return (
    <div className={`vjp-output-card${hidden ? ' is-hidden' : ''}`}>
      <div className={`vjp-gate-mark${icon === 'error' ? ' is-warn' : ''}`}>
        {icon === 'error' ? (
          <AlertTriangle size={30} />
        ) : icon === 'wait' ? (
          <RefreshCw size={30} className="vjp-spin" />
        ) : icon === 'plug' ? (
          <Cable size={30} />
        ) : (
          <Monitor size={30} />
        )}
      </div>
      <strong>{title}</strong>
      <p>{body}</p>
      {slots !== undefined && slots.length > 0 ? (
        <div className="vjp-slots">
          {slots.map((name) => (
            <code key={name}>{name}</code>
          ))}
        </div>
      ) : null}
      {hint !== undefined ? <small>{hint}</small> : null}
    </div>
  )
}
