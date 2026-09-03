/**
 * Browser-side signaling client for the room server (`/signal/<room>`).
 *
 * This module is transport only: it knows about peers and opaque payloads, not
 * about SDP, ICE, or media. `hub.ts` layers WebRTC on top of it. There is no
 * React here — the store exposes `subscribe()` so a component can bind with
 * `useSyncExternalStore`.
 */

export type PeerRole = 'editor' | 'publisher' | 'display'
export type PeerInfo = { peerId: string; role: PeerRole; slot: string; label: string }
export type SignalStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface SignalClient {
  readonly status: SignalStatus
  readonly error: string | null
  readonly peers: PeerInfo[]
  readonly peerId: string
  connect(room: string, self: Omit<PeerInfo, 'peerId'>): void
  disconnect(): void
  send(to: string, payload: unknown): void
  onSignal(handler: (from: string, payload: unknown) => void): () => void
  onPeers(handler: (peers: PeerInfo[]) => void): () => void
  subscribe(listener: () => void): () => void
}

/**
 * Ports that mean "a Vite server is serving the app, so the room server is a
 * separate process". 5173 is `vite dev`, 4173 is `vite preview`. Any other port
 * (including the default 80/443) means the app was served *by* the room server,
 * so signaling lives on the same origin.
 */
const VITE_PORTS = new Set(['5173', '4173'])
const DEFAULT_SERVER_PORT = '8787'

/** Escape hatch for tunnels/ngrok: set `window.__ROOM_SERVER_URL__` before load. */
const overrideUrl = (): string | null => {
  const value = (globalThis as { __ROOM_SERVER_URL__?: unknown }).__ROOM_SERVER_URL__
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Base websocket URL of the room server, e.g. `ws://192.168.1.20:8787`.
 *
 * Deliberately derived from `location` rather than configured, because the
 * phone loads the page from the laptop's LAN address and must then signal back
 * to that same address.
 */
export function resolveServerUrl(): string {
  const explicit = overrideUrl()
  if (explicit !== null) return explicit.replace(/\/+$/, '')

  const loc = typeof location === 'undefined' ? null : location
  if (loc === null) return `ws://localhost:${DEFAULT_SERVER_PORT}`

  // A page served over https must use wss, or the browser blocks the socket.
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'

  if (VITE_PORTS.has(loc.port)) {
    return `${scheme}//${loc.hostname}:${DEFAULT_SERVER_PORT}`
  }
  return `${scheme}//${loc.host}`
}

const roomSocketUrl = (room: string): string =>
  `${resolveServerUrl()}/signal/${encodeURIComponent(room)}`

const RECONNECT_BASE_MS = 400
const RECONNECT_MAX_MS = 10_000

const backoffDelay = (attempt: number): number => {
  const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
  // Jitter keeps an editor + phone + projector from all retrying in lockstep
  // after the laptop's Wi-Fi blips.
  return exponential / 2 + Math.random() * (exponential / 2)
}

const randomPeerId = (): string => {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID().slice(0, 8)
  if (typeof c?.getRandomValues === 'function') {
    const bytes = new Uint8Array(4)
    c.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(36).slice(2, 10)
}

const ROLES: ReadonlySet<string> = new Set<PeerRole>(['editor', 'publisher', 'display'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parsePeer = (value: unknown): PeerInfo | null => {
  if (!isRecord(value)) return null
  const { peerId, role, slot, label } = value
  if (typeof peerId !== 'string' || peerId.length === 0) return null
  if (typeof role !== 'string' || !ROLES.has(role)) return null
  return {
    peerId,
    role: role as PeerRole,
    slot: typeof slot === 'string' ? slot : '',
    label: typeof label === 'string' ? label : '',
  }
}

/** Run a user callback without ever letting it escape into an event handler. */
const safely = (label: string, fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    console.error(`[signal] ${label} handler threw:`, err)
  }
}

type Desired = { room: string; self: Omit<PeerInfo, 'peerId'> }

class SignalClientImpl implements SignalClient {
  status: SignalStatus = 'offline'
  error: string | null = null
  peers: PeerInfo[] = []
  readonly peerId: string = randomPeerId()

  #socket: WebSocket | null = null
  #desired: Desired | null = null
  #attempt = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #outbox: string[] = []

  readonly #storeListeners = new Set<() => void>()
  readonly #signalHandlers = new Set<(from: string, payload: unknown) => void>()
  readonly #peerHandlers = new Set<(peers: PeerInfo[]) => void>()

  connect(room: string, self: Omit<PeerInfo, 'peerId'>): void {
    if (typeof WebSocket === 'undefined') {
      this.#fail('This browser has no WebSocket support.')
      return
    }

    const sameRoom = this.#desired?.room === room
    const sameSelf =
      this.#desired?.self.role === self.role &&
      this.#desired?.self.slot === self.slot &&
      this.#desired?.self.label === self.label
    this.#desired = { room, self }

    if (sameRoom && this.#socket !== null) {
      // Already pointed at the right room; just refresh our advertised identity
      // (e.g. the publisher relabelled its slot).
      if (!sameSelf) this.#sendRaw(this.#helloMessage())
      return
    }

    if (!sameRoom) this.#teardownSocket(1000, 'switching room')
    this.#openSocket()
  }

  disconnect(): void {
    this.#desired = null
    this.#attempt = 0
    this.#clearReconnect()
    this.#outbox = []
    this.#teardownSocket(1000, 'client disconnect')
    this.peers = []
    this.error = null
    this.status = 'offline'
    this.#emitPeers()
    this.#notify()
  }

  send(to: string, payload: unknown): void {
    let json: string
    try {
      json = JSON.stringify({ type: 'signal', to, from: this.peerId, payload })
    } catch (err) {
      console.error('[signal] payload is not serialisable:', err)
      return
    }
    this.#sendRaw(json)
  }

  onSignal(handler: (from: string, payload: unknown) => void): () => void {
    this.#signalHandlers.add(handler)
    return () => {
      this.#signalHandlers.delete(handler)
    }
  }

  onPeers(handler: (peers: PeerInfo[]) => void): () => void {
    this.#peerHandlers.add(handler)
    return () => {
      this.#peerHandlers.delete(handler)
    }
  }

  subscribe(listener: () => void): () => void {
    this.#storeListeners.add(listener)
    return () => {
      this.#storeListeners.delete(listener)
    }
  }

  // -- internals ----------------------------------------------------------

  #helloMessage(): string {
    const self = this.#desired?.self
    return JSON.stringify({
      type: 'hello',
      peerId: this.peerId,
      role: self?.role ?? 'editor',
      slot: self?.slot ?? '',
      label: self?.label ?? '',
    })
  }

  /** Send now if open, otherwise buffer until the socket finishes connecting. */
  #sendRaw(json: string): void {
    const socket = this.#socket
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(json)
        return
      } catch (err) {
        console.warn('[signal] send failed, buffering:', err)
      }
    }
    // Bound the buffer: if we are offline for minutes, ancient SDP is useless.
    if (this.#outbox.length < 256) this.#outbox.push(json)
  }

  #flushOutbox(): void {
    const socket = this.#socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) return
    const pending = this.#outbox
    this.#outbox = []
    for (const json of pending) {
      try {
        socket.send(json)
      } catch (err) {
        console.warn('[signal] flush failed:', err)
      }
    }
  }

  #openSocket(): void {
    const desired = this.#desired
    if (desired === null) return
    this.#clearReconnect()

    let socket: WebSocket
    try {
      socket = new WebSocket(roomSocketUrl(desired.room))
    } catch (err) {
      this.#fail(err instanceof Error ? err.message : 'Could not open signaling socket.')
      this.#scheduleReconnect()
      return
    }

    this.#socket = socket
    this.status = 'connecting'
    this.error = null
    this.#notify()

    socket.onopen = () => {
      if (this.#socket !== socket) return
      this.#attempt = 0
      this.status = 'online'
      this.error = null
      // hello goes first so the server can announce us before any queued SDP.
      try {
        socket.send(this.#helloMessage())
      } catch (err) {
        console.warn('[signal] hello failed:', err)
      }
      this.#flushOutbox()
      this.#notify()
    }

    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.#socket !== socket) return
      safely('message', () => {
        this.#handleMessage(event.data)
      })
    }

    socket.onerror = () => {
      if (this.#socket !== socket) return
      // The error event carries no detail by spec; `onclose` follows and drives
      // reconnection, so only record a message.
      this.error = 'Signaling connection error.'
      this.#notify()
    }

    socket.onclose = (event: CloseEvent) => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.peers = []
      this.#emitPeers()
      if (this.#desired === null) {
        this.status = 'offline'
        this.#notify()
        return
      }
      this.status = 'connecting'
      if (event.code !== 1000 && event.code !== 1001 && this.error === null) {
        this.error = `Signaling closed (${event.code}${event.reason ? `: ${event.reason}` : ''}).`
      }
      this.#notify()
      this.#scheduleReconnect()
    }
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(msg)) return

    if (msg.type === 'peers' && Array.isArray(msg.peers)) {
      const next: PeerInfo[] = []
      for (const raw of msg.peers) {
        const peer = parsePeer(raw)
        if (peer !== null) next.push(peer)
      }
      this.peers = next
      this.#emitPeers()
      this.#notify()
      return
    }

    if (msg.type === 'bye' && typeof msg.peerId === 'string') {
      // Fast path: the server also resends `peers`, but acting on `bye`
      // immediately lets the hub tear down a dead RTCPeerConnection sooner.
      const before = this.peers.length
      this.peers = this.peers.filter((p) => p.peerId !== msg.peerId)
      if (this.peers.length !== before) {
        this.#emitPeers()
        this.#notify()
      }
      return
    }

    if (msg.type === 'signal' && typeof msg.from === 'string') {
      const from = msg.from
      const payload = msg.payload
      for (const handler of [...this.#signalHandlers]) {
        safely('signal', () => handler(from, payload))
      }
      return
    }

    if (msg.type === 'unreachable' && typeof msg.peerId === 'string') {
      console.warn(`[signal] peer ${msg.peerId} is no longer in the room`)
    }
  }

  #scheduleReconnect(): void {
    if (this.#desired === null || this.#reconnectTimer !== null) return
    const delay = backoffDelay(this.#attempt)
    this.#attempt = Math.min(this.#attempt + 1, 16)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#openSocket()
    }, delay)
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer === null) return
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = null
  }

  #teardownSocket(code: number, reason: string): void {
    const socket = this.#socket
    this.#socket = null
    if (socket === null) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(code, reason)
    } catch {
      // Closing an already-closed socket is not an error worth surfacing.
    }
  }

  #fail(message: string): void {
    this.status = 'error'
    this.error = message
    this.#notify()
  }

  #emitPeers(): void {
    const snapshot = this.peers
    for (const handler of [...this.#peerHandlers]) {
      safely('peers', () => handler(snapshot))
    }
  }

  #notify(): void {
    for (const listener of [...this.#storeListeners]) {
      safely('subscribe', listener)
    }
  }
}

export function createSignalClient(): SignalClient {
  return new SignalClientImpl()
}

/** Shared instance; one signaling socket per tab is plenty. */
export const signalClient: SignalClient = createSignalClient()
