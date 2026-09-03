/**
 * WebRTC signaling relay protocol and peer manager for Edge runtime.
 */

export type PeerRole = 'editor' | 'publisher' | 'display'

export interface PeerInfo {
  peerId: string
  role: PeerRole
  slot: string
  label: string
}

export type SignalMessage =
  | { type: 'hello'; peerId: string; role?: PeerRole; slot?: string; label?: string }
  | { type: 'signal'; to: string; from?: string; payload: unknown }
  | { type: 'bye'; peerId?: string }
  | { type: 'peers'; peers: PeerInfo[] }
  | { type: 'unreachable'; peerId: string }

const ROLES: ReadonlySet<string> = new Set<PeerRole>(['editor', 'publisher', 'display'])

function asShortString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : fallback
}

export class SignalRoomManager {
  private readonly peers = new Map<string, PeerInfo & { ws: WebSocket }>()

  get size(): number {
    return this.peers.size
  }

  publicPeers(): PeerInfo[] {
    return [...this.peers.values()].map(({ peerId, role, slot, label }) => ({
      peerId,
      role,
      slot,
      label,
    }))
  }

  registerPeer(msg: { peerId: unknown; role?: unknown; slot?: unknown; label?: unknown }, ws: WebSocket): PeerInfo | null {
    const id = asShortString(msg.peerId)
    if (!id) return null

    // If peer reconnected with same id, close old socket
    const existing = this.peers.get(id)
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, 'replaced by newer connection')
      } catch {
        /* ignore */
      }
    }

    const role: PeerRole = typeof msg.role === 'string' && ROLES.has(msg.role) ? (msg.role as PeerRole) : 'editor'
    const peer: PeerInfo & { ws: WebSocket } = {
      peerId: id,
      role,
      slot: asShortString(msg.slot),
      label: asShortString(msg.label),
      ws,
    }

    this.peers.set(id, peer)
    return peer
  }

  removePeer(peerId: string, ws: WebSocket): boolean {
    const existing = this.peers.get(peerId)
    if (existing && existing.ws === ws) {
      this.peers.delete(peerId)
      return true
    }
    return false
  }

  getPeerSocket(peerId: string): WebSocket | null {
    return this.peers.get(peerId)?.ws ?? null
  }

  broadcast(message: SignalMessage, exceptWs?: WebSocket): void {
    const payload = JSON.stringify(message)
    for (const peer of this.peers.values()) {
      if (peer.ws !== exceptWs && peer.ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          peer.ws.send(payload)
        } catch {
          /* ignore */
        }
      }
    }
  }

  sendTo(ws: WebSocket, message: SignalMessage): void {
    if (ws.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        ws.send(JSON.stringify(message))
      } catch {
        /* ignore */
      }
    }
  }
}
