/**
 * WebRTC media hub.
 *
 * Topology is intentionally asymmetric and fixed:
 *
 *   publisher (phone camera)  --offer-->  editor (laptop running the graph)
 *
 * The publisher always creates the offer, the editor always answers. Fixing the
 * direction removes almost all of the glare that perfect negotiation exists to
 * handle, but the guards are still implemented (see `#onDescription`) because a
 * camera switch or an ICE restart can produce a second offer while the editor
 * is still applying the first.
 *
 * No React here; `subscribe()` is for `useSyncExternalStore`.
 */

import { signalClient, type PeerInfo } from './signal'

export type RemoteStream = { slot: string; peerId: string; label: string; stream: MediaStream; since: number }
export type HubStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface MediaHub {
  readonly status: HubStatus
  readonly error: string | null
  readonly room: string | null
  /** Streams currently arriving from publishers, keyed by slot. */
  readonly streams: Map<string, RemoteStream>
  /** Editor side: join a room and accept incoming publisher streams. */
  joinAsEditor(room: string): void
  /** Publisher side (phone): join and send this stream on the given slot. */
  publish(room: string, slot: string, label: string, stream: MediaStream): void
  /** Stop publishing but stay connected. */
  unpublish(): void
  leave(): void
  subscribe(listener: () => void): () => void
}

/**
 * Public STUN only.
 *
 * The primary use case — phone and laptop on the same Wi-Fi — connects on host
 * candidates alone and would work even with an empty ICE server list; STUN is
 * here for the case where the two devices are on different subnets of the same
 * network. Anything that crosses a real NAT boundary (phone on cellular, editor
 * behind a symmetric NAT, corporate/guest Wi-Fi with client isolation) needs a
 * TURN relay, which cannot be a public freebie because it carries the media.
 * Add one here as `{ urls, username, credential }` if the demo has to leave the
 * LAN.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

type Mode = 'idle' | 'editor' | 'publisher'

type Description = { kind: 'description'; description: RTCSessionDescriptionInit; slot: string; label: string }
type Candidate = { kind: 'candidate'; candidate: RTCIceCandidateInit | null }
/** Editor -> publisher: "my ICE died, please re-offer with an ICE restart." */
type RestartRequest = { kind: 'restart' }
type HubMessage = Description | Candidate | RestartRequest

type Conn = {
  readonly peerId: string
  readonly pc: RTCPeerConnection
  /** The polite peer yields on collision. The editor (answerer) is polite. */
  readonly polite: boolean
  slot: string
  label: string
  makingOffer: boolean
  ignoreOffer: boolean
  settingRemoteAnswer: boolean
  iceRestarted: boolean
  senders: RTCRtpSender[]
  closed: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseMessage = (payload: unknown): HubMessage | null => {
  if (!isRecord(payload)) return null
  if (payload.kind === 'restart') return { kind: 'restart' }
  if (payload.kind === 'candidate') {
    const c = payload.candidate
    if (c === null || c === undefined) return { kind: 'candidate', candidate: null }
    if (!isRecord(c)) return null
    return { kind: 'candidate', candidate: c as RTCIceCandidateInit }
  }
  if (payload.kind === 'description' && isRecord(payload.description)) {
    const { type, sdp } = payload.description
    if (type !== 'offer' && type !== 'answer' && type !== 'pranswer' && type !== 'rollback') return null
    return {
      kind: 'description',
      description: { type, sdp: typeof sdp === 'string' ? sdp : undefined },
      slot: typeof payload.slot === 'string' ? payload.slot : '',
      label: typeof payload.label === 'string' ? payload.label : '',
    }
  }
  return null
}

const webrtcSupported = (): boolean =>
  typeof RTCPeerConnection !== 'undefined' && typeof MediaStream !== 'undefined'

class MediaHubImpl implements MediaHub {
  status: HubStatus = 'offline'
  error: string | null = null
  room: string | null = null
  streams: Map<string, RemoteStream> = new Map()

  #mode: Mode = 'idle'
  #localStream: MediaStream | null = null
  #slot = ''
  #label = ''

  readonly #conns = new Map<string, Conn>()
  readonly #listeners = new Set<() => void>()
  #unsubSignal: (() => void) | null = null
  #unsubPeers: (() => void) | null = null
  #unsubStore: (() => void) | null = null

  // -- public API ---------------------------------------------------------

  joinAsEditor(room: string): void {
    if (!this.#assertSupport()) return
    if (this.#mode === 'editor' && this.room === room) return
    this.#resetForJoin(room, 'editor')
    signalClient.connect(room, { role: 'editor', slot: '', label: 'editor' })
    this.#syncStatus()
  }

  publish(room: string, slot: string, label: string, stream: MediaStream): void {
    if (!this.#assertSupport()) return
    if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
      this.#fail('This browser exposes no navigator.mediaDevices, so it cannot publish a camera.')
      return
    }

    const switchingStreamOnly = this.#mode === 'publisher' && this.room === room && this.#slot === slot
    this.#localStream = stream
    this.#slot = slot
    this.#label = label

    if (switchingStreamOnly) {
      // Camera flip / device change: swap the outgoing track in place.
      // replaceTrack does not touch the SDP, so no renegotiation and no visible
      // freeze on the editor side.
      for (const conn of this.#conns.values()) {
        conn.slot = slot
        conn.label = label
        this.#applyLocalTracks(conn)
      }
      signalClient.connect(room, { role: 'publisher', slot, label })
      this.#syncStatus()
      return
    }

    this.#resetForJoin(room, 'publisher')
    this.#localStream = stream
    this.#slot = slot
    this.#label = label
    signalClient.connect(room, { role: 'publisher', slot, label })
    this.#syncStatus()
  }

  unpublish(): void {
    this.#localStream = null
    for (const conn of this.#conns.values()) {
      for (const sender of conn.senders) {
        // null keeps the transceiver (and therefore the negotiated m-line)
        // alive while sending nothing, so resuming needs no renegotiation.
        void sender.replaceTrack(null).catch((err: unknown) => {
          console.warn('[hub] replaceTrack(null) failed:', err)
        })
      }
    }
    this.#notify()
  }

  leave(): void {
    this.#closeAllConns()
    this.#detachSignal()
    // The MediaStream belongs to whoever called publish(); stopping its tracks
    // here would kill a camera preview the UI is still showing.
    this.#localStream = null
    this.#slot = ''
    this.#label = ''
    this.#mode = 'idle'
    this.room = null
    this.error = null
    this.status = 'offline'
    if (this.streams.size > 0) this.streams = new Map()
    signalClient.disconnect()
    this.#notify()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  // -- wiring -------------------------------------------------------------

  #assertSupport(): boolean {
    if (webrtcSupported()) return true
    this.#fail('This browser has no WebRTC support (RTCPeerConnection is missing).')
    return false
  }

  #resetForJoin(room: string, mode: Mode): void {
    this.#closeAllConns()
    this.#detachSignal()
    if (this.streams.size > 0) this.streams = new Map()
    this.#mode = mode
    this.room = room
    this.error = null
    this.#localStream = null

    this.#unsubSignal = signalClient.onSignal((from, payload) => {
      void this.#onSignal(from, payload)
    })
    this.#unsubPeers = signalClient.onPeers((peers) => {
      this.#onPeers(peers)
    })
    this.#unsubStore = signalClient.subscribe(() => {
      this.#syncStatus()
    })
  }

  #detachSignal(): void {
    this.#unsubSignal?.()
    this.#unsubPeers?.()
    this.#unsubStore?.()
    this.#unsubSignal = null
    this.#unsubPeers = null
    this.#unsubStore = null
  }

  #onPeers(peers: PeerInfo[]): void {
    const present = new Set(peers.map((p) => p.peerId))

    // Drop connections to peers that left, and their streams.
    for (const [peerId, conn] of [...this.#conns]) {
      if (present.has(peerId)) continue
      this.#dropConn(conn, 'peer left')
    }

    if (this.#mode === 'publisher') {
      // Offer to every editor in the room, including ones that join later.
      // `display` peers are skipped on purpose: a projector consumes the
      // editor's rendered output, not a raw camera, so sending to it would
      // burn an RTCPeerConnection on the phone for nothing. A display that
      // does want raw publisher streams should join via `joinAsEditor`.
      for (const peer of peers) {
        if (peer.peerId === signalClient.peerId) continue
        if (peer.role !== 'editor') continue
        if (this.#conns.has(peer.peerId)) continue
        const conn = this.#createConn(peer.peerId, false)
        conn.slot = this.#slot
        conn.label = this.#label
        this.#applyLocalTracks(conn)
      }
    } else if (this.#mode === 'editor') {
      // Editors do not initiate; keep the advertised slot/label fresh for any
      // publisher we already have a connection with.
      for (const peer of peers) {
        const conn = this.#conns.get(peer.peerId)
        if (conn === undefined || peer.role !== 'publisher') continue
        if (peer.slot !== '' && conn.slot !== peer.slot) {
          this.#renameSlot(conn, peer.slot)
        }
        if (peer.label !== '') conn.label = peer.label
      }
    }

    this.#syncStatus()
  }

  #createConn(peerId: string, polite: boolean): Conn {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' })
    const conn: Conn = {
      peerId,
      pc,
      polite,
      slot: '',
      label: '',
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      iceRestarted: false,
      senders: [],
      closed: false,
    }
    this.#conns.set(peerId, conn)

    pc.onnegotiationneeded = () => {
      void this.#negotiate(conn)
    }

    pc.onicecandidate = (event) => {
      const message: Candidate = {
        kind: 'candidate',
        candidate: event.candidate === null ? null : event.candidate.toJSON(),
      }
      signalClient.send(peerId, message)
    }

    pc.ontrack = (event) => {
      this.#onTrack(conn, event)
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState !== 'failed') return
      if (!conn.iceRestarted) {
        conn.iceRestarted = true
        console.warn(`[hub] ICE failed with ${peerId}, attempting one restart`)
        if (conn.polite) {
          // Only the offerer can perform an ICE restart, so ask them to.
          const request: RestartRequest = { kind: 'restart' }
          signalClient.send(peerId, request)
        } else {
          try {
            pc.restartIce()
          } catch (err) {
            console.warn('[hub] restartIce failed:', err)
          }
        }
        return
      }
      this.#fail(`Media connection to ${peerId} failed. On a mixed network this usually means a TURN server is required.`)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        // A successful (re)connect clears a previous transient failure.
        conn.iceRestarted = false
        if (this.error !== null) this.error = null
      }
      if (pc.connectionState === 'closed') {
        this.#dropConn(conn, 'connection closed')
      }
      this.#syncStatus()
    }

    return conn
  }

  /** Attach or swap the local stream's tracks on a publisher connection. */
  #applyLocalTracks(conn: Conn): void {
    const stream = this.#localStream
    if (stream === null) return
    const tracks = stream.getTracks()
    if (tracks.length === 0) return

    if (conn.senders.length === 0) {
      conn.senders = tracks.map((track) => conn.pc.addTrack(track, stream))
      return
    }

    // Existing connection: replaceTrack per kind, never addTrack again.
    for (const sender of conn.senders) {
      const kind = sender.track?.kind
      const replacement =
        tracks.find((t) => t.kind === kind) ??
        (kind === undefined ? tracks.find((t) => t.kind === 'video') : undefined)
      if (replacement === undefined) continue
      if (sender.track === replacement) continue
      void sender.replaceTrack(replacement).catch((err: unknown) => {
        console.warn('[hub] replaceTrack failed:', err)
      })
    }
  }

  async #negotiate(conn: Conn): Promise<void> {
    if (conn.closed || conn.polite) return
    try {
      conn.makingOffer = true
      await conn.pc.setLocalDescription()
      const local = conn.pc.localDescription
      if (local === null) return
      const message: Description = {
        kind: 'description',
        description: { type: local.type, sdp: local.sdp },
        slot: this.#slot,
        label: this.#label,
      }
      signalClient.send(conn.peerId, message)
    } catch (err) {
      console.warn('[hub] negotiation failed:', err)
      this.#fail(err instanceof Error ? err.message : 'Negotiation failed.')
    } finally {
      conn.makingOffer = false
    }
  }

  async #onSignal(from: string, payload: unknown): Promise<void> {
    if (this.#mode === 'idle') return
    const message = parseMessage(payload)
    if (message === null) return

    let conn = this.#conns.get(from)
    if (conn === undefined) {
      // Only the editor accepts a connection it did not initiate, and only in
      // response to a description (a stray candidate is not worth a new pc).
      if (this.#mode !== 'editor' || message.kind !== 'description') return
      conn = this.#createConn(from, true)
    }

    if (message.kind === 'restart') {
      if (!conn.polite) {
        try {
          conn.pc.restartIce()
        } catch (err) {
          console.warn('[hub] restartIce failed:', err)
        }
      }
      return
    }

    if (message.kind === 'candidate') {
      try {
        // `null` means end-of-candidates; addIceCandidate accepts it.
        await conn.pc.addIceCandidate(message.candidate ?? undefined)
      } catch (err) {
        // Candidates that arrive for an offer we deliberately ignored are
        // expected garbage, not a real failure.
        if (!conn.ignoreOffer) console.warn('[hub] addIceCandidate failed:', err)
      }
      return
    }

    await this.#onDescription(conn, message)
  }

  async #onDescription(conn: Conn, message: Description): Promise<void> {
    const { pc } = conn
    const description = message.description

    if (message.slot !== '') this.#renameSlot(conn, message.slot)
    if (message.label !== '') conn.label = message.label

    /**
     * Perfect negotiation guard. `readyForOffer` is false while we have an
     * un-answered local offer or a remote answer still being applied; taking a
     * remote offer in that window is what deadlocks a peer connection. The
     * impolite side (the publisher) drops the colliding offer; the polite side
     * (the editor) rolls back implicitly via setRemoteDescription.
     */
    const readyForOffer = !conn.makingOffer && (pc.signalingState === 'stable' || conn.settingRemoteAnswer)
    const offerCollision = description.type === 'offer' && !readyForOffer

    conn.ignoreOffer = !conn.polite && offerCollision
    if (conn.ignoreOffer) return

    try {
      conn.settingRemoteAnswer = description.type === 'answer'
      await pc.setRemoteDescription(description)
      conn.settingRemoteAnswer = false

      if (description.type !== 'offer') return

      await pc.setLocalDescription()
      const local = pc.localDescription
      if (local === null) return
      const answer: Description = {
        kind: 'description',
        description: { type: local.type, sdp: local.sdp },
        slot: this.#mode === 'publisher' ? this.#slot : conn.slot,
        label: this.#mode === 'publisher' ? this.#label : conn.label,
      }
      signalClient.send(conn.peerId, answer)
    } catch (err) {
      conn.settingRemoteAnswer = false
      console.warn('[hub] applying description failed:', err)
      this.#fail(err instanceof Error ? err.message : 'Failed to apply remote description.')
    }
  }

  #onTrack(conn: Conn, event: RTCTrackEvent): void {
    const stream = event.streams[0] ?? new MediaStream([event.track])
    // Fall back to the peer id so an unlabelled publisher still shows up
    // somewhere instead of silently overwriting slot ''.
    const slot = conn.slot !== '' ? conn.slot : conn.peerId
    conn.slot = slot

    const next = new Map(this.streams)
    next.set(slot, {
      slot,
      peerId: conn.peerId,
      label: conn.label !== '' ? conn.label : conn.peerId,
      stream,
      since: Date.now(),
    })
    this.streams = next

    const forget = () => {
      const current = this.streams.get(slot)
      if (current === undefined || current.peerId !== conn.peerId) return
      const without = new Map(this.streams)
      without.delete(slot)
      this.streams = without
      this.#notify()
    }
    event.track.addEventListener('ended', forget)
    stream.addEventListener('removetrack', () => {
      if (stream.getTracks().length === 0) forget()
    })

    this.#notify()
  }

  /** Move a conn's stream entry when we learn its real slot after `ontrack`. */
  #renameSlot(conn: Conn, slot: string): void {
    const previous = conn.slot
    conn.slot = slot
    if (previous === slot) return
    const existing = this.streams.get(previous)
    if (existing === undefined || existing.peerId !== conn.peerId) return
    const next = new Map(this.streams)
    next.delete(previous)
    next.set(slot, { ...existing, slot })
    this.streams = next
    this.#notify()
  }

  #dropConn(conn: Conn, reason: string): void {
    if (conn.closed) return
    conn.closed = true
    this.#conns.delete(conn.peerId)

    const pc = conn.pc
    pc.onnegotiationneeded = null
    pc.onicecandidate = null
    pc.ontrack = null
    pc.oniceconnectionstatechange = null
    pc.onconnectionstatechange = null
    try {
      pc.close()
    } catch {
      // Already closed.
    }
    conn.senders = []

    const stream = this.streams.get(conn.slot)
    if (stream !== undefined && stream.peerId === conn.peerId) {
      const next = new Map(this.streams)
      next.delete(conn.slot)
      this.streams = next
    }
    console.log(`[hub] dropped ${conn.peerId} (${reason})`)
    this.#notify()
  }

  #closeAllConns(): void {
    for (const conn of [...this.#conns.values()]) {
      this.#dropConn(conn, 'leaving')
    }
    this.#conns.clear()
  }

  #syncStatus(): void {
    const previous = this.status
    const previousError = this.error

    if (this.#mode === 'idle') {
      this.status = 'offline'
    } else if (signalClient.status === 'error') {
      this.status = 'error'
      if (this.error === null) this.error = signalClient.error
    } else if (this.error !== null && this.#conns.size === 0) {
      this.status = 'error'
    } else if (signalClient.status === 'online') {
      this.status = 'online'
    } else {
      this.status = 'connecting'
    }

    if (this.status !== previous || this.error !== previousError) this.#notify()
  }

  #fail(message: string): void {
    this.error = message
    this.status = 'error'
    this.#notify()
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (err) {
        console.error('[hub] subscriber threw:', err)
      }
    }
  }
}

export const mediaHub: MediaHub = new MediaHubImpl()
