/**
 * WebRTC media hub with symmetric peer-to-peer negotiation.
 *
 * Topology:
 *   - Any peer (editor, phone publisher, display) in the same room can establish
 *     a WebRTC peer connection.
 *   - Perfect negotiation (polite / impolite based on peerId comparison: `peerId < remotePeerId`)
 *     handles simultaneous offers and re-negotiation smoothly without collision deadlocks.
 *   - Peers can publish multiple local streams (e.g. webcam, screen share) to designated
 *     slots (`cam-1`, `screen-1`, etc.).
 *   - Incoming streams from any peer are registered into `mediaHub.streams` by slot.
 *   - Local published streams are also mirrored in `mediaHub.streams` and `mediaHub.localStreams`
 *     so the local editor/renderer can access them immediately.
 *
 * No React here; `subscribe()` is for `useSyncExternalStore`.
 */

import { signalClient, type PeerInfo } from './signal'

export type RemoteStream = {
  slot: string
  peerId: string
  label: string
  stream: MediaStream
  since: number
  isLocal?: boolean
}

export type HubStatus = 'offline' | 'connecting' | 'online' | 'error'

export interface MediaHub {
  readonly status: HubStatus
  readonly error: string | null
  readonly room: string | null
  /** Streams currently active in the room (both remote and local), keyed by slot. */
  readonly streams: Map<string, RemoteStream>
  /** Local streams published by this client, keyed by slot. */
  readonly localStreams: Map<string, { slot: string; label: string; stream: MediaStream }>
  /** Editor side: join a room and communicate with all peers. */
  joinAsEditor(room: string): void
  /** Publisher side (phone): join and send this stream on the given slot. */
  publish(room: string, slot: string, label: string, stream: MediaStream): void
  /** Publish a stream on a specific slot (works for both editors and publishers). */
  publishStream(slot: string, label: string, stream: MediaStream): void
  /** Stop publishing a specific slot. */
  unpublishSlot(slot: string): void
  /** Stop publishing the legacy primary stream or all local streams. */
  unpublish(): void
  leave(): void
  subscribe(listener: () => void): () => void
}

/**
 * Public STUN servers.
 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

type Mode = 'idle' | 'editor' | 'publisher'

type Description = {
  kind: 'description'
  description: RTCSessionDescriptionInit
  slot: string
  label: string
  streamId?: string
}

type Candidate = { kind: 'candidate'; candidate: RTCIceCandidateInit | null }
type RestartRequest = { kind: 'restart' }
type SlotAnnouncement = { kind: 'slots'; slots: Array<{ slot: string; label: string; streamId: string }> }

type HubMessage = Description | Candidate | RestartRequest | SlotAnnouncement

type LocalPublication = {
  slot: string
  label: string
  stream: MediaStream
}

type Conn = {
  readonly peerId: string
  readonly pc: RTCPeerConnection
  readonly polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  settingRemoteAnswer: boolean
  iceRestarted: boolean
  /** Map from track ID to sender */
  senders: Map<string, RTCRtpSender>
  closed: boolean
  /** Remote slots advertised by this peer: slot -> { label, streamId } */
  remoteSlots: Map<string, { label: string; streamId: string }>
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
  if (payload.kind === 'slots' && Array.isArray(payload.slots)) {
    return {
      kind: 'slots',
      slots: payload.slots
        .filter(isRecord)
        .map((s) => ({
          slot: typeof s.slot === 'string' ? s.slot : '',
          label: typeof s.label === 'string' ? s.label : '',
          streamId: typeof s.streamId === 'string' ? s.streamId : '',
        })),
    }
  }
  if (payload.kind === 'description' && isRecord(payload.description)) {
    const { type, sdp } = payload.description
    if (type !== 'offer' && type !== 'answer' && type !== 'pranswer' && type !== 'rollback') return null
    return {
      kind: 'description',
      description: { type, sdp: typeof sdp === 'string' ? sdp : undefined },
      slot: typeof payload.slot === 'string' ? payload.slot : '',
      label: typeof payload.label === 'string' ? payload.label : '',
      streamId: typeof payload.streamId === 'string' ? payload.streamId : undefined,
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
  localStreams: Map<string, LocalPublication> = new Map()

  #mode: Mode = 'idle'
  #legacySlot = ''
  #legacyLabel = ''

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

    this.#legacySlot = slot
    this.#legacyLabel = label

    if (this.#mode !== 'publisher' || this.room !== room) {
      this.#resetForJoin(room, 'publisher')
      signalClient.connect(room, { role: 'publisher', slot, label })
    }

    this.publishStream(slot, label, stream)
  }

  publishStream(slot: string, label: string, stream: MediaStream): void {
    this.localStreams.set(slot, { slot, label, stream })

    // Also add to streams map so local nodes can see it
    const nextStreams = new Map(this.streams)
    nextStreams.set(slot, {
      slot,
      peerId: signalClient.peerId,
      label,
      stream,
      since: Date.now(),
      isLocal: true,
    })
    this.streams = nextStreams

    // Apply tracks to all active connections
    for (const conn of this.#conns.values()) {
      this.#syncConnTracks(conn)
    }

    // Broadcast updated slot announcements to all peers
    this.#broadcastSlots()
    this.#notify()
  }

  unpublishSlot(slot: string): void {
    const pub = this.localStreams.get(slot)
    if (!pub) return

    this.localStreams.delete(slot)

    // Remove tracks from connections
    for (const track of pub.stream.getTracks()) {
      for (const conn of this.#conns.values()) {
        const sender = conn.senders.get(track.id)
        if (sender) {
          try {
            conn.pc.removeTrack(sender)
          } catch {
            /* ignore */
          }
          conn.senders.delete(track.id)
        }
      }
    }

    // Remove local stream from streams map
    const current = this.streams.get(slot)
    if (current && current.peerId === signalClient.peerId) {
      const nextStreams = new Map(this.streams)
      nextStreams.delete(slot)
      this.streams = nextStreams
    }

    this.#broadcastSlots()
    this.#notify()
  }

  unpublish(): void {
    for (const slot of [...this.localStreams.keys()]) {
      this.unpublishSlot(slot)
    }
  }

  leave(): void {
    this.unpublish()
    this.#closeAllConns()
    this.#detachSignal()
    this.#legacySlot = ''
    this.#legacyLabel = ''
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
    this.localStreams.clear()
    this.#mode = mode
    this.room = room
    this.error = null

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

  #broadcastSlots(): void {
    if (this.room === null) return
    const slots = [...this.localStreams.values()].map((pub) => ({
      slot: pub.slot,
      label: pub.label,
      streamId: pub.stream.id,
    }))
    const msg: SlotAnnouncement = { kind: 'slots', slots }
    for (const conn of this.#conns.values()) {
      signalClient.send(conn.peerId, msg)
    }
  }

  #onPeers(peers: PeerInfo[]): void {
    const present = new Set(peers.map((p) => p.peerId))

    // Drop connections to peers that left, and their streams.
    for (const [peerId, conn] of [...this.#conns]) {
      if (present.has(peerId)) continue
      this.#dropConn(conn, 'peer left')
    }

    // Connect to every other peer in the room (editors and publishers)
    for (const peer of peers) {
      if (peer.peerId === signalClient.peerId) continue
      // Skip pure display peers (projector) unless they published a stream
      if (peer.role === 'display') continue

      let conn = this.#conns.get(peer.peerId)
      if (!conn) {
        // Tie-breaker for perfect negotiation:
        // The peer with the alphabetically smaller peerId is polite.
        const polite = signalClient.peerId < peer.peerId
        conn = this.#createConn(peer.peerId, polite)
        if (peer.slot) {
          conn.remoteSlots.set(peer.slot, { label: peer.label || peer.slot, streamId: '' })
        }
        this.#syncConnTracks(conn)
      } else {
        if (peer.slot && !conn.remoteSlots.has(peer.slot)) {
          conn.remoteSlots.set(peer.slot, { label: peer.label || peer.slot, streamId: '' })
        }
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
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      iceRestarted: false,
      senders: new Map(),
      closed: false,
      remoteSlots: new Map(),
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
        console.warn(`[hub] ICE failed with ${peerId}, attempting restart`)
        if (conn.polite) {
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
        conn.iceRestarted = false
        if (this.error !== null) this.error = null
        // Send our published slots announcement to newly connected peer
        const slots = [...this.localStreams.values()].map((pub) => ({
          slot: pub.slot,
          label: pub.label,
          streamId: pub.stream.id,
        }))
        if (slots.length > 0) {
          signalClient.send(peerId, { kind: 'slots', slots } satisfies SlotAnnouncement)
        }
      }
      if (pc.connectionState === 'closed') {
        this.#dropConn(conn, 'connection closed')
      }
      this.#syncStatus()
    }

    return conn
  }

  /** Synchronizes local tracks to a peer connection. */
  #syncConnTracks(conn: Conn): void {
    if (conn.closed) return
    const activeTrackIds = new Set<string>()

    for (const pub of this.localStreams.values()) {
      for (const track of pub.stream.getTracks()) {
        activeTrackIds.add(track.id)
        if (!conn.senders.has(track.id)) {
          try {
            const sender = conn.pc.addTrack(track, pub.stream)
            conn.senders.set(track.id, sender)
          } catch (err) {
            console.warn(`[hub] failed to addTrack ${track.id}:`, err)
          }
        }
      }
    }

    // Remove senders for tracks that are no longer local
    for (const [trackId, sender] of [...conn.senders.entries()]) {
      if (!activeTrackIds.has(trackId)) {
        try {
          conn.pc.removeTrack(sender)
        } catch {
          /* ignore */
        }
        conn.senders.delete(trackId)
      }
    }
  }

  async #negotiate(conn: Conn): Promise<void> {
    if (conn.closed) return
    try {
      conn.makingOffer = true
      await conn.pc.setLocalDescription()
      const local = conn.pc.localDescription
      if (local === null) return
      const message: Description = {
        kind: 'description',
        description: { type: local.type, sdp: local.sdp },
        slot: this.#legacySlot,
        label: this.#legacyLabel,
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
      // Connect to any peer offering a connection
      const polite = signalClient.peerId < from
      conn = this.#createConn(from, polite)
    }

    if (message.kind === 'slots') {
      for (const s of message.slots) {
        conn.remoteSlots.set(s.slot, { label: s.label, streamId: s.streamId })
        // If we already have a stream matching this streamId, ensure its slot is correct
        for (const [slotKey, remoteStream] of this.streams.entries()) {
          if (remoteStream.peerId === from && remoteStream.stream.id === s.streamId && slotKey !== s.slot) {
            const nextStreams = new Map(this.streams)
            nextStreams.delete(slotKey)
            nextStreams.set(s.slot, { ...remoteStream, slot: s.slot, label: s.label || s.slot })
            this.streams = nextStreams
            this.#notify()
          }
        }
      }
      return
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
        await conn.pc.addIceCandidate(message.candidate ?? undefined)
      } catch (err) {
        if (!conn.ignoreOffer) console.warn('[hub] addIceCandidate failed:', err)
      }
      return
    }

    await this.#onDescription(conn, message)
  }

  async #onDescription(conn: Conn, message: Description): Promise<void> {
    const { pc } = conn
    const description = message.description

    if (message.slot !== '') {
      conn.remoteSlots.set(message.slot, { label: message.label || message.slot, streamId: message.streamId || '' })
    }

    /**
     * Perfect negotiation guard.
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
        slot: this.#legacySlot,
        label: this.#legacyLabel,
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

    // Find the slot advertised for this stream or peer
    let slot = ''
    let label = ''

    for (const [s, info] of conn.remoteSlots.entries()) {
      if (info.streamId && info.streamId === stream.id) {
        slot = s
        label = info.label
        break
      }
    }

    if (!slot) {
      // Pick first slot from conn.remoteSlots or fallback to peerId
      const firstEntry = [...conn.remoteSlots.entries()][0]
      if (firstEntry) {
        slot = firstEntry[0]
        label = firstEntry[1].label
      } else {
        slot = conn.peerId
        label = conn.peerId
      }
    }

    const next = new Map(this.streams)
    next.set(slot, {
      slot,
      peerId: conn.peerId,
      label: label || slot,
      stream,
      since: Date.now(),
      isLocal: false,
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
    conn.senders.clear()

    // Remove any streams coming from this peer (except our local streams)
    const nextStreams = new Map(this.streams)
    let changed = false
    for (const [slot, st] of this.streams.entries()) {
      if (st.peerId === conn.peerId && !st.isLocal) {
        nextStreams.delete(slot)
        changed = true
      }
    }
    if (changed) {
      this.streams = nextStreams
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
