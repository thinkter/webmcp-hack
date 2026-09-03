/**
 * `/join?room=ABC&slot=cam-1` — the phone publisher.
 *
 * This screen is held by a performer, not by the person who built the patch: it
 * is read once, in the dark, possibly on stage, with no chance to ask questions.
 * Everything here follows from that.
 *
 * The three details that decide whether it works in the room:
 *
 * 1. `getUserMedia` is never called on mount. iOS only grants capture inside a
 *    user gesture, and an unprompted permission dialog on page load reads as
 *    hostile — people deny it, and a denied permission is sticky.
 * 2. The preview is `playsInline muted autoPlay`. Without `playsInline`, iOS
 *    takes over the page with its native fullscreen player and the controls
 *    below become unreachable.
 * 3. A screen wake lock is held while publishing. A phone that locks mid-set
 *    kills the feed, and nobody on stage is going to notice and tap it awake.
 *
 * The most common real failure is not WebRTC at all: it is opening this link
 * over plain `http://` from a LAN address, where `getUserMedia` does not exist.
 * That is detected up front rather than left to fail as a mystery.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Camera, CameraOff, Lock, RefreshCw, Smartphone, SwitchCamera, X } from 'lucide-react'
import { mediaHub } from '../remote/hub'
import { parseRoomParams } from '../remote/links'
import { signalClient } from '../remote/signal'
import './pages.css'

type Facing = 'user' | 'environment'
type Phase = 'idle' | 'starting' | 'live' | 'failed'
type Failure = { title: string; detail: string; steps: string[] }
type WakeLockState = 'unsupported' | 'held' | 'off'

const DEFAULT_SLOT = 'cam-1'

// Class methods use private fields, so the listener must be wrapped rather than
// passed unbound. Module scope keeps the reference stable across renders, which
// `useSyncExternalStore` requires to avoid resubscribing every commit.
const subscribeHub = (listener: () => void): (() => void) => mediaHub.subscribe(listener)
const subscribeSignal = (listener: () => void): (() => void) => signalClient.subscribe(listener)

// ------------------------------------------------------------ environment ----

type Browser = { family: 'safari' | 'chrome' | 'firefox' | 'other'; ios: boolean; name: string }

const detectBrowser = (): Browser => {
  if (typeof navigator === 'undefined') return { family: 'other', ios: false, name: 'your browser' }
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as a Mac; the touch-point count gives it away.
  const ios =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

  if (/FxiOS|Firefox/i.test(ua)) return { family: 'firefox', ios, name: 'Firefox' }
  // Order matters: Chrome's UA string also contains "Safari".
  if (/CriOS|EdgiOS|Edg\/|Chrome|Chromium/i.test(ua)) {
    return { family: 'chrome', ios, name: 'Chrome' }
  }
  if (/Safari/i.test(ua)) return { family: 'safari', ios, name: 'Safari' }
  return { family: 'other', ios, name: 'your browser' }
}

const BROWSER = detectBrowser()

/** Steps that actually un-block a camera, per browser. Generic advice is useless here. */
const denialSteps = (browser: Browser): string[] => {
  if (browser.ios && browser.family === 'safari') {
    return [
      'Tap the "aA" or ⚙ icon at the left of the address bar.',
      'Choose Website Settings ▸ Camera ▸ Allow.',
      'If Camera is not listed, open Settings ▸ Safari ▸ Camera and set it to Ask.',
      'Reload this page, then tap Start camera again.',
    ]
  }
  if (browser.ios) {
    return [
      `On iOS the camera is granted per app, so the block is on ${browser.name}, not on this page.`,
      `Open Settings ▸ ${browser.name} ▸ Camera and turn it on.`,
      'Reload this page, then tap Start camera again.',
    ]
  }
  if (browser.family === 'chrome') {
    return [
      'Tap the sliders or padlock icon at the left of the address bar.',
      'Open Permissions ▸ Camera and choose Allow (or tap Reset permissions).',
      'Reload the page, then tap Start camera again.',
    ]
  }
  if (browser.family === 'firefox') {
    return [
      'Tap the padlock icon in the address bar.',
      'Clear the blocked Camera permission for this site.',
      'Reload the page, then tap Start camera again.',
    ]
  }
  return [
    "Open this site's permissions in your browser settings and allow the camera.",
    'Reload the page, then tap Start camera again.',
  ]
}

type Blocker = { icon: 'lock' | 'camera'; title: string; detail: string; steps: string[] }

/**
 * Reasons this device can never publish, checked before any UI promises that it
 * can. Ordered by how specific the advice can be.
 */
const probeEnvironment = (): Blocker | null => {
  if (typeof window === 'undefined') return null

  // THE trap. On plain http:// from anything other than localhost the browser
  // deletes `navigator.mediaDevices` entirely, so without this check the user
  // just gets "camera failed" with no reason.
  if (!window.isSecureContext) {
    const host = window.location.host
    return {
      icon: 'lock',
      title: 'This link is not secure, so the camera is blocked',
      detail:
        `Browsers only allow camera access on https, or on localhost. This page came from ` +
        `http://${host}, so ${BROWSER.name} has switched the camera off before the page could even ask.`,
      steps: [
        'Show this screen to whoever sent you the link — it is fixed on their machine, not yours.',
        'They need to serve the editor over https (a Cloudflare Tunnel, ngrok, or a local certificate all work) and re-share the QR code.',
        ...(BROWSER.family === 'chrome' && !BROWSER.ios
          ? [
              `As a workaround on Chrome only: open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add http://${host}, and relaunch the browser.`,
            ]
          : []),
      ],
    }
  }

  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return {
      icon: 'camera',
      title: 'This browser cannot share a camera',
      detail: `${BROWSER.name} does not expose navigator.mediaDevices.getUserMedia on this page, so there is no way to capture video.`,
      steps: [
        'Try the device\'s default browser (Safari on iOS, Chrome on Android).',
        'If you are inside an in-app browser — Instagram, Slack, a QR scanner — use its "Open in browser" menu item.',
      ],
    }
  }

  if (typeof RTCPeerConnection === 'undefined') {
    return {
      icon: 'camera',
      title: 'This browser has no WebRTC support',
      detail:
        'The camera could be opened, but there is no RTCPeerConnection, so the video has no way to reach the editor.',
      steps: ['Open this link in Safari (iOS) or Chrome (Android) instead.'],
    }
  }

  return null
}

// ---------------------------------------------------------------- helpers ----

const prettySlot = (slot: string): string => {
  const words = slot
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
  return words.length > 0 ? words : 'Camera'
}

/** Mirrors `session.ts`'s room normalisation so a typed code matches the editor's. */
const normalizeRoomInput = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 120)

const errorName = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name
    if (typeof name === 'string') return name
  }
  return ''
}

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : 'No further detail was reported.'

const describeMediaError = (error: unknown, browser: Browser): Failure => {
  const name = errorName(error)

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return {
      title: 'Camera access was blocked',
      detail: 'Nothing is being captured or sent. The permission has to be re-allowed by hand.',
      steps: denialSteps(browser),
    }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      title: 'No usable camera was found',
      detail: 'The browser reported no video input it is willing to open on this device.',
      steps: [
        'Close any other app that might be holding the camera (the camera app, a video call).',
        'Reload the page and try again.',
      ],
    }
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: 'The camera is busy',
      detail: 'Another app or tab already has this camera open, so the hardware refused a second capture.',
      steps: [
        'Close other camera apps and video calls, including other browser tabs.',
        'Then tap Try again.',
      ],
    }
  }
  return {
    title: 'The camera could not be started',
    detail: errorMessage(error),
    steps: ['Tap Try again. If it keeps failing, reload the page.'],
  }
}

const videoTrackOf = (stream: MediaStream | null): MediaStreamTrack | null => {
  if (stream === null) return null
  const tracks = stream.getVideoTracks()
  return tracks.length > 0 ? tracks[0] : null
}

const stopTracks = (stream: MediaStream | null): void => {
  if (stream === null) return
  for (const track of stream.getTracks()) track.stop()
}

const facingName = (facing: Facing): string => (facing === 'user' ? 'Front camera' : 'Rear camera')

/** Label the editor shows next to the incoming stream. */
const publishLabel = (facing: Facing, stream: MediaStream): string => {
  const label = videoTrackOf(stream)?.label ?? ''
  return label.trim().length > 0 ? label.trim() : facingName(facing)
}

/**
 * The Screen Wake Lock API is Chromium-only at the time of writing, so it is
 * feature-detected rather than assumed. `navigator.wakeLock` is *typed* as
 * always present, which is exactly the sort of lie that crashes Safari.
 */
const wakeLockApi = (): WakeLock | null => {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null
  const api: WakeLock | undefined = navigator.wakeLock
  return api !== undefined && typeof api.request === 'function' ? api : null
}

// ------------------------------------------------------------- publishing ----

type Publisher = {
  phase: Phase
  failure: Failure | null
  stream: MediaStream | null
  facing: Facing
  devices: MediaDeviceInfo[]
  deviceId: string | null
  wakeLock: WakeLockState
  /** The tab was backgrounded while live, so the feed may have stalled. */
  interrupted: boolean
  /** `getUserMedia` has been pending long enough that something is probably wrong. */
  slowStart: boolean
  /** The OS muted the track — a phone call, or another app grabbing the camera. */
  trackMuted: boolean
  start: () => void
  retry: () => void
  flip: () => void
  chooseDevice: (deviceId: string) => void
  stop: () => void
  dismissInterrupted: () => void
}

function useCameraPublisher(room: string | null, slot: string): Publisher {
  const streamRef = useRef<MediaStream | null>(null)
  const wakeRef = useRef<WakeLockSentinel | null>(null)

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [facing, setFacing] = useState<Facing>('environment')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [wakeLock, setWakeLock] = useState<WakeLockState>(() =>
    wakeLockApi() === null ? 'unsupported' : 'off',
  )
  const [interrupted, setInterrupted] = useState(false)
  const [trackMuted, setTrackMuted] = useState(false)
  const [slowStart, setSlowStart] = useState(false)

  // -- wake lock ------------------------------------------------------------

  const acquireWakeLock = useCallback(async (): Promise<void> => {
    const api = wakeLockApi()
    if (api === null) return
    const held = wakeRef.current
    if (held !== null && !held.released) return
    try {
      const sentinel = await api.request('screen')
      wakeRef.current = sentinel
      setWakeLock('held')
      // The browser drops the lock whenever the page is hidden; reflect that
      // instead of claiming the screen is still being held awake.
      sentinel.addEventListener('release', () => {
        if (wakeRef.current === sentinel) wakeRef.current = null
        setWakeLock((current) => (current === 'unsupported' ? current : 'off'))
      })
    } catch {
      // Requesting while hidden, or with a low battery, throws. Not an error
      // worth putting on screen — the feed still works.
      setWakeLock((current) => (current === 'unsupported' ? current : 'off'))
    }
  }, [])

  const releaseWakeLock = useCallback((): void => {
    const sentinel = wakeRef.current
    wakeRef.current = null
    setWakeLock((current) => (current === 'unsupported' ? current : 'off'))
    if (sentinel === null || sentinel.released) return
    void sentinel.release().catch(() => undefined)
  }, [])

  // -- devices --------------------------------------------------------------

  const refreshDevices = useCallback(async (): Promise<void> => {
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (media === undefined || typeof media.enumerateDevices !== 'function') return
    try {
      const all = await media.enumerateDevices()
      setDevices(all.filter((device) => device.kind === 'videoinput'))
    } catch {
      // Enumeration is a nicety; the facing toggle does not depend on it.
    }
  }, [])

  // -- capture --------------------------------------------------------------

  const acquire = useCallback(
    async (target: { deviceId: string | null; facing: Facing }): Promise<void> => {
      if (room === null) return
      const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
      if (media === undefined || typeof media.getUserMedia !== 'function') return

      setPhase('starting')
      setFailure(null)

      /**
       * 720p30, explicitly bounded.
       *
       * An unconstrained request is a trap on a phone: the browser hands back
       * the sensor's preferred mode, which on a modern handset is 4K, and the
       * bottleneck is never the pixels. It is the encoder (a phone SoC will
       * thermally throttle and start dropping frames within a minute) and the
       * uplink (Wi-Fi in a venue full of people is a hostile radio environment).
       * 720p30 encodes cheaply, fits in a few Mbit/s, and is already more than
       * the graph needs once it has been through a couple of feedback passes.
       */
      const base: MediaTrackConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      }

      // Ordered fallbacks. `facingMode: exact` is what actually flips the camera
      // on a phone; `ideal` is the version that still returns *a* camera on a
      // laptop, where there is no front/rear at all.
      const attempts: MediaTrackConstraints[] = []
      if (target.deviceId !== null) attempts.push({ ...base, deviceId: { exact: target.deviceId } })
      attempts.push({ ...base, facingMode: { exact: target.facing } })
      attempts.push({ ...base, facingMode: { ideal: target.facing } })
      attempts.push({ ...base })

      const previous = streamRef.current
      let releasedPrevious = previous === null
      let next: MediaStream | null = null
      let lastError: unknown = null

      for (const video of attempts) {
        try {
          next = await media.getUserMedia({ video, audio: false })
          break
        } catch (error) {
          lastError = error
          const name = errorName(error)
          // A denial is final. Retrying only re-prompts, which reads as nagging
          // and makes people permanently deny.
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') break
          // iOS will not open a second capture while the first is live, so a
          // camera switch fails here. Give up the old track and retry once.
          if (
            !releasedPrevious &&
            (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
          ) {
            releasedPrevious = true
            stopTracks(previous)
            try {
              next = await media.getUserMedia({ video, audio: false })
              break
            } catch (retryError) {
              lastError = retryError
            }
          }
        }
      }

      if (next === null) {
        if (releasedPrevious && previous !== null) {
          // The old camera was sacrificed for a retry that also failed; do not
          // leave the UI claiming to be live.
          streamRef.current = null
          setStream(null)
          mediaHub.unpublish()
        }
        setFailure(describeMediaError(lastError, BROWSER))
        setPhase('failed')
        return
      }

      // Release the old capture only once the new one is in hand, so a failed
      // switch leaves the performer still on air.
      if (!releasedPrevious && previous !== null && previous !== next) stopTracks(previous)

      streamRef.current = next
      setStream(next)

      const track = videoTrackOf(next)
      const settings = track?.getSettings()
      const resolvedFacing: Facing =
        settings?.facingMode === 'user' || settings?.facingMode === 'environment'
          ? settings.facingMode
          : target.facing
      setFacing(resolvedFacing)
      setDeviceId(typeof settings?.deviceId === 'string' ? settings.deviceId : target.deviceId)
      setTrackMuted(track?.muted ?? false)
      setInterrupted(false)

      // The hub replaces the outgoing track in place when the room and slot are
      // unchanged, so switching cameras never renegotiates and the editor sees
      // no freeze.
      mediaHub.publish(room, slot, publishLabel(resolvedFacing, next), next)
      setPhase('live')

      // Device labels are empty until a capture has been granted, so the list
      // is only worth building now.
      void refreshDevices()
      void acquireWakeLock()
    },
    [room, slot, refreshDevices, acquireWakeLock],
  )

  const start = useCallback((): void => {
    // No pinned deviceId on the first grant: let the platform pick, which is
    // the camera the user expects and the one least likely to fail.
    void acquire({ deviceId: null, facing })
  }, [acquire, facing])

  const retry = useCallback((): void => {
    void acquire({ deviceId, facing })
  }, [acquire, deviceId, facing])

  const flip = useCallback((): void => {
    // Clearing the deviceId matters: an exact deviceId outranks facingMode, so
    // keeping it would flip nothing.
    void acquire({ deviceId: null, facing: facing === 'user' ? 'environment' : 'user' })
  }, [acquire, facing])

  const chooseDevice = useCallback(
    (id: string): void => {
      void acquire({ deviceId: id, facing })
    },
    [acquire, facing],
  )

  const stop = useCallback((): void => {
    mediaHub.unpublish()
    mediaHub.leave()
    stopTracks(streamRef.current)
    streamRef.current = null
    setStream(null)
    setPhase('idle')
    setFailure(null)
    setInterrupted(false)
    setTrackMuted(false)
    releaseWakeLock()
  }, [releaseWakeLock])

  const dismissInterrupted = useCallback((): void => setInterrupted(false), [])

  // -- track health ---------------------------------------------------------

  useEffect(() => {
    const track = videoTrackOf(stream)
    if (track === null) return

    const onEnded = (): void => {
      setPhase('failed')
      setFailure({
        title: 'The camera stopped',
        detail:
          'The device ended the video track. This usually means another app took the camera, or the browser reclaimed it in the background.',
        steps: ['Tap Try again to reopen the camera.'],
      })
    }
    const onMute = (): void => setTrackMuted(true)
    const onUnmute = (): void => setTrackMuted(false)

    track.addEventListener('ended', onEnded)
    track.addEventListener('mute', onMute)
    track.addEventListener('unmute', onUnmute)
    return () => {
      track.removeEventListener('ended', onEnded)
      track.removeEventListener('mute', onMute)
      track.removeEventListener('unmute', onUnmute)
    }
  }, [stream])

  // -- slow start -----------------------------------------------------------

  // `getUserMedia` stays pending for as long as the permission dialog is up,
  // which is correct — but it can also stay pending forever (a dialog that was
  // never drawn, an in-app browser that swallows the request, a camera the OS
  // will not hand over). Without this, the only affordance left on screen is a
  // disabled button, which is a dead end on stage.
  useEffect(() => {
    if (phase !== 'starting') {
      setSlowStart(false)
      return
    }
    const timer = window.setTimeout(() => setSlowStart(true), 12_000)
    return () => window.clearTimeout(timer)
  }, [phase])

  // -- backgrounding --------------------------------------------------------

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        // Mobile browsers throttle hidden tabs hard: rAF stops, timers are
        // clamped, and the encoder can be suspended outright. The feed may be
        // frozen on the editor without anything here reporting an error.
        if (phase === 'live') setInterrupted(true)
        return
      }
      // Wake locks are always released when the page is hidden, so it has to be
      // taken again on the way back.
      if (phase === 'live') void acquireWakeLock()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [phase, acquireWakeLock])

  useEffect(() => {
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (media === undefined || typeof media.addEventListener !== 'function') return
    const onChange = (): void => {
      void refreshDevices()
    }
    media.addEventListener('devicechange', onChange)
    return () => media.removeEventListener('devicechange', onChange)
  }, [refreshDevices])

  // -- teardown -------------------------------------------------------------

  // One unconditional cleanup for the whole page. Nothing is acquired on mount,
  // so StrictMode's mount → unmount → mount cannot leave a second camera open:
  // the first cleanup has nothing to release.
  useEffect(
    () => () => {
      mediaHub.unpublish()
      mediaHub.leave()
      const current = streamRef.current
      streamRef.current = null
      stopTracks(current)
      const sentinel = wakeRef.current
      wakeRef.current = null
      if (sentinel !== null && !sentinel.released) void sentinel.release().catch(() => undefined)
    },
    [],
  )

  return {
    phase,
    failure,
    stream,
    facing,
    devices,
    deviceId,
    wakeLock,
    interrupted,
    slowStart,
    trackMuted,
    start,
    retry,
    flip,
    chooseDevice,
    stop,
    dismissInterrupted,
  }
}

// ------------------------------------------------------------------- page ----

export function JoinPage() {
  const [params] = useState(() => parseRoomParams())
  const [room, setRoom] = useState<string | null>(params.room)
  const [slot, setSlot] = useState<string>(params.slot ?? DEFAULT_SLOT)
  const blocker = useMemo(() => probeEnvironment(), [])

  const publisher = useCameraPublisher(room, slot)
  const videoRef = useRef<HTMLVideoElement>(null)

  const hubStatus = useSyncExternalStore(subscribeHub, () => mediaHub.status)
  const hubError = useSyncExternalStore(subscribeHub, () => mediaHub.error)
  const peers = useSyncExternalStore(subscribeSignal, () => signalClient.peers)
  const editorPresent = peers.some((peer) => peer.role === 'editor')

  // `srcObject` has no attribute form, so it has to be assigned imperatively.
  useEffect(() => {
    const element = videoRef.current
    if (element === null) return
    element.srcObject = publisher.stream
    if (publisher.stream === null) return
    // Muted inline video is allowed to autoplay, but Safari occasionally needs
    // the explicit nudge after a track swap. A rejection here is benign.
    void element.play().catch(() => undefined)
  }, [publisher.stream])

  const onRoomSubmit = useCallback((nextRoom: string, nextSlot: string): void => {
    // Keep the URL honest so a reload — or handing the phone to someone else —
    // lands on the same slot without retyping.
    const url = new URL(window.location.href)
    url.searchParams.set('room', nextRoom)
    url.searchParams.set('slot', nextSlot)
    window.history.replaceState(null, '', url.toString())
    setRoom(nextRoom)
    setSlot(nextSlot)
  }, [])

  if (blocker !== null) {
    return (
      <Gate
        icon={blocker.icon}
        tone="warn"
        title={blocker.title}
        detail={blocker.detail}
        steps={blocker.steps}
      />
    )
  }

  if (room === null) {
    return <RoomGate slot={slot} onSubmit={onRoomSubmit} />
  }

  const live = publisher.phase === 'live'
  const connection: { tone: 'live' | 'connecting' | 'error' | 'idle'; text: string } = !live
    ? publisher.phase === 'starting'
      ? { tone: 'connecting', text: 'Starting camera' }
      : publisher.phase === 'failed'
        ? { tone: 'error', text: 'Failed' }
        : { tone: 'idle', text: 'Camera off' }
    : hubStatus === 'error'
      ? { tone: 'error', text: 'Connection failed' }
      : hubStatus === 'online'
        ? editorPresent
          ? { tone: 'live', text: 'Live' }
          : { tone: 'connecting', text: 'Waiting for editor' }
        : { tone: 'connecting', text: 'Connecting' }

  const deviceListUseful =
    publisher.devices.length > 1 && publisher.devices.some((device) => device.label.trim().length > 0)

  return (
    <div className="vjp vjp-join">
      {/* playsInline is not optional: without it iOS replaces the page with its
          own fullscreen player and every control below becomes unreachable. */}
      <video
        ref={videoRef}
        className={`vjp-join-video${publisher.facing === 'user' ? ' is-mirrored' : ''}`}
        playsInline
        muted
        autoPlay
        disablePictureInPicture
        aria-label="Camera preview"
      />
      <div className={`vjp-join-veil${publisher.stream === null ? ' is-blank' : ''}`} />

      <header>
        <div className="vjp-join-identity">
          <span>Publishing as</span>
          <strong>{prettySlot(slot)}</strong>
          <code>
            slot {slot} · room {room}
          </code>
        </div>
        <span className={`vjp-pill is-${connection.tone}`}>
          <i />
          {connection.text}
        </span>
      </header>

      <div className={`vjp-join-body${live ? '' : ' is-centred'}`}>
        {publisher.failure !== null ? (
          <div className="vjp-note is-error">
            <AlertTriangle size={20} />
            <div>
              <strong>{publisher.failure.title}</strong>
              <p>{publisher.failure.detail}</p>
              <ol className="vjp-steps">
                {publisher.failure.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}

        {live && hubError !== null ? (
          <div className="vjp-note is-warn">
            <AlertTriangle size={20} />
            <div>
              <strong>The connection is struggling</strong>
              <p>{hubError}</p>
              <p className="vjp-muted">
                The camera is still running. This usually clears itself; if it does not, both devices
                need to be on the same Wi-Fi.
              </p>
            </div>
          </div>
        ) : null}

        {publisher.interrupted ? (
          <div className="vjp-note is-warn">
            <AlertTriangle size={20} />
            <div>
              <strong>This tab went into the background</strong>
              <p>
                Phones throttle or suspend hidden tabs, so the editor may be showing a frozen frame.
                Tap Restart camera if the picture looks stuck.
              </p>
            </div>
            <button
              type="button"
              className="vjp-dismiss"
              onClick={publisher.dismissInterrupted}
              aria-label="Dismiss"
            >
              <X size={18} />
            </button>
          </div>
        ) : null}

        {publisher.phase === 'starting' && publisher.slowStart ? (
          <div className="vjp-note is-warn">
            <AlertTriangle size={20} />
            <div>
              <strong>Still waiting for the camera</strong>
              <p>
                {BROWSER.name} has not answered the request. If you cannot see a dialog asking to
                allow the camera, the permission was probably blocked earlier.
              </p>
              <ol className="vjp-steps">
                {denialSteps(BROWSER).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <button
                type="button"
                className="vjp-btn vjp-btn-small"
                style={{ marginTop: 12 }}
                onClick={() => window.location.reload()}
              >
                <RefreshCw size={16} />
                Reload the page
              </button>
            </div>
          </div>
        ) : null}

        {live && publisher.trackMuted ? (
          <div className="vjp-note is-warn">
            <AlertTriangle size={20} />
            <div>
              <strong>The camera is muted by the system</strong>
              <p>
                Something else took the camera — a call, or another app. The editor is receiving
                black frames until it is released.
              </p>
            </div>
          </div>
        ) : null}

        {publisher.phase === 'idle' && publisher.failure === null ? (
          <div className="vjp-note">
            <Smartphone size={20} />
            <div>
              <strong>You are about to share this camera</strong>
              <p>
                Tap the button below and allow camera access. The video goes straight to the
                {' '}
                {prettySlot(slot)} input of the patch in room {room} — nothing is recorded here.
              </p>
            </div>
          </div>
        ) : null}

        {live && !editorPresent ? (
          <div className="vjp-note">
            <RefreshCw size={20} className="vjp-spin" />
            <div>
              <strong>Waiting for the editor</strong>
              <p>
                You are in room {room}. As soon as the laptop running the patch is in the same room,
                this feed appears on {prettySlot(slot)}.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <footer>
        {live ? (
          <>
            <div className="vjp-join-row">
              <button
                type="button"
                className="vjp-btn vjp-btn-icon"
                onClick={publisher.flip}
                aria-label={`Switch to the ${publisher.facing === 'user' ? 'rear' : 'front'} camera`}
              >
                <SwitchCamera size={26} />
              </button>
              <button type="button" className="vjp-btn vjp-btn-danger" onClick={publisher.stop}>
                <CameraOff size={20} />
                Stop camera
              </button>
            </div>

            {deviceListUseful ? (
              <select
                className="vjp-select"
                value={publisher.deviceId ?? ''}
                onChange={(event) => publisher.chooseDevice(event.target.value)}
                aria-label="Camera"
              >
                {publisher.deviceId === null ? <option value="">Default camera</option> : null}
                {publisher.devices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label.trim().length > 0 ? device.label : `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            ) : null}

            <p className="vjp-muted">
              {facingName(publisher.facing)} ·{' '}
              {publisher.wakeLock === 'held'
                ? 'the screen is being kept awake'
                : publisher.wakeLock === 'unsupported'
                  ? `${BROWSER.name} cannot keep the screen awake — set Auto-Lock to Never before the set`
                  : 'the screen may lock; keep this page in the foreground'}
            </p>
          </>
        ) : publisher.phase === 'starting' ? (
          <button type="button" className="vjp-btn vjp-btn-primary" disabled>
            <RefreshCw size={22} className="vjp-spin" />
            Starting camera…
          </button>
        ) : (
          <button type="button" className="vjp-btn vjp-btn-primary" onClick={publisher.phase === 'failed' ? publisher.retry : publisher.start}>
            <Camera size={24} />
            {publisher.phase === 'failed' ? 'Try again' : 'Start camera'}
          </button>
        )}
      </footer>
    </div>
  )
}

// -------------------------------------------------------------- sub-screens ----

function Gate({
  icon,
  tone,
  title,
  detail,
  steps,
  children,
}: {
  icon: 'lock' | 'camera'
  tone: 'warn' | 'neutral'
  title: string
  detail: string
  steps?: string[]
  children?: React.ReactNode
}) {
  return (
    <div className="vjp vjp-gate">
      <div className={`vjp-gate-mark${tone === 'warn' ? ' is-warn' : ''}`}>
        {icon === 'lock' ? <Lock size={26} /> : <CameraOff size={26} />}
      </div>
      <h1>{title}</h1>
      <p>{detail}</p>
      {steps !== undefined && steps.length > 0 ? (
        <div className="vjp-gate-detail">
          <ol className="vjp-steps">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {children}
    </div>
  )
}

/**
 * No `?room=` in the URL. Almost always a hand-typed or truncated link, so this
 * is a form rather than an error: the room code is short and unambiguous by
 * design (no 0/O, no 1/I/L) precisely so it can be read off a screen and typed.
 */
function RoomGate({
  slot,
  onSubmit,
}: {
  slot: string
  onSubmit: (room: string, slot: string) => void
}) {
  const [roomInput, setRoomInput] = useState('')
  const [slotInput, setSlotInput] = useState(slot)
  const room = normalizeRoomInput(roomInput)
  const ready = room.length > 0

  return (
    <div className="vjp vjp-gate">
      <div className="vjp-gate-mark">
        <Smartphone size={26} />
      </div>
      <h1>Which room?</h1>
      <p>
        This link is missing its room code. Ask the person running the visuals for the code on their
        screen, or scan their QR code instead — that carries the code for you.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready) return
          const nextSlot = slotInput.trim().length > 0 ? slotInput.trim() : DEFAULT_SLOT
          onSubmit(room, nextSlot)
        }}
      >
        <label className="vjp-field">
          <span>Room code</span>
          <input
            className="vjp-input"
            value={roomInput}
            onChange={(event) => setRoomInput(event.target.value)}
            placeholder="ABC123"
            // No autocorrect or capitalisation help: this is a code, and iOS
            // will happily turn it into a word.
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="go"
            maxLength={24}
            aria-label="Room code"
          />
        </label>

        <label className="vjp-field">
          <span>Camera slot</span>
          <input
            className="vjp-input vjp-input-plain"
            value={slotInput}
            onChange={(event) => setSlotInput(event.target.value)}
            placeholder={DEFAULT_SLOT}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            aria-label="Camera slot"
          />
        </label>

        <button type="submit" className="vjp-btn vjp-btn-primary" disabled={!ready}>
          Continue
        </button>
      </form>

      <p className="vjp-muted">
        The slot is the name of the input in the patch — the VJ will tell you if it is not{' '}
        {DEFAULT_SLOT}.
      </p>
    </div>
  )
}
