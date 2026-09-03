/**
 * Cloudflare Durable Object managing a stateful room (Yjs CRDT + WebRTC signaling).
 */

import { DurableObject } from 'cloudflare:workers'
import * as Y from 'yjs'
import { Reader, toUint8Array } from './codec'
import {
  AwarenessStore,
  createStep1Message,
  createStep2Message,
  createUpdateMessage,
  MSG_AWARENESS,
  MSG_QUERY_AWARENESS,
  MSG_SYNC,
  parseAwarenessMessage,
  SYNC_STEP_1,
  SYNC_STEP_2,
  SYNC_UPDATE,
} from './yjs-sync'
import { SignalMessage, SignalRoomManager } from './signaling'
import { RoomStorage } from './storage'

export interface Env {
  ROOM_DO: DurableObjectNamespace<RoomDurableObject>
  ASSETS?: Fetcher
}

type WsMetadata =
  | { kind: 'yjs'; controlledIds: number[] }
  | { kind: 'signal'; peerId: string | null }

export class RoomDurableObject extends DurableObject<Env> {
  private readonly doc = new Y.Doc()
  private readonly awareness = new AwarenessStore()
  private readonly signaling = new SignalRoomManager()
  private readonly roomStorage: RoomStorage
  private readonly wsMeta = new Map<WebSocket, WsMetadata>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.roomStorage = new RoomStorage(ctx.storage)

    ctx.blockConcurrencyWhile(async () => {
      await this.roomStorage.loadDocument(this.doc)
    })

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const message = createUpdateMessage(update)
      for (const ws of this.ctx.getWebSockets('yjs')) {
        if (ws !== origin && ws.readyState === WebSocket.READY_STATE_OPEN) {
          try {
            ws.send(message)
          } catch {
            /* dead socket */
          }
        }
      }
      this.scheduleSave()
    })
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.roomStorage.saveDocument(this.doc)
    }, 2000)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const upgradeHeader = request.headers.get('Upgrade')

    if (upgradeHeader !== 'websocket') {
      return Response.json({
        ok: true,
        room: url.pathname.replace(/^\/(yjs|signal)\/?/, ''),
        yjsClients: this.ctx.getWebSockets('yjs').length,
        signalPeers: this.signaling.size,
      })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    const isSignal = url.pathname.startsWith('/signal')
    const tag = isSignal ? 'signal' : 'yjs'

    this.ctx.acceptWebSocket(server, [tag])

    if (isSignal) {
      this.wsMeta.set(server, { kind: 'signal', peerId: null })
      this.signaling.sendTo(server, { type: 'peers', peers: this.signaling.publicPeers() })
    } else {
      this.wsMeta.set(server, { kind: 'yjs', controlledIds: [] })
      // Step 1: advertise state vector
      try {
        server.send(createStep1Message(this.doc))
        const snapshot = this.awareness.snapshot()
        if (snapshot) server.send(snapshot)
      } catch {
        /* ignore */
      }
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = this.wsMeta.get(ws)

    // Handle Signaling
    if (meta?.kind === 'signal') {
      let msg: SignalMessage
      try {
        msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
      } catch {
        return
      }

      if (msg.type === 'hello') {
        const peer = this.signaling.registerPeer(msg, ws)
        if (peer) {
          meta.peerId = peer.peerId
          this.signaling.broadcast({ type: 'peers', peers: this.signaling.publicPeers() })
        }
        return
      }

      if (msg.type === 'signal') {
        if (!meta.peerId) return
        const targetWs = this.signaling.getPeerSocket(msg.to)
        if (!targetWs) {
          this.signaling.sendTo(ws, { type: 'unreachable', peerId: msg.to })
          return
        }
        this.signaling.sendTo(targetWs, {
          type: 'signal',
          to: msg.to,
          from: meta.peerId,
          payload: msg.payload,
        })
        return
      }

      if (msg.type === 'bye') {
        try {
          ws.close(1000, 'client said bye')
        } catch {
          /* ignore */
        }
      }
      return
    }

    // Handle Yjs
    const bytes = toUint8Array(message)
    const reader = new Reader(bytes)
    let type: number
    try {
      type = reader.varUint()
    } catch {
      return
    }

    if (type === MSG_SYNC) {
      const step = reader.varUint()
      if (step === SYNC_STEP_1) {
        const stateVector = reader.varBytes()
        ws.send(createStep2Message(this.doc, stateVector))
      } else if (step === SYNC_STEP_2 || step === SYNC_UPDATE) {
        const update = reader.varBytes()
        Y.applyUpdate(this.doc, update, ws)
      }
      return
    }

    if (type === MSG_AWARENESS) {
      const payload = reader.varBytes()
      const entries = parseAwarenessMessage(new Reader(payload))
      const accepted = this.awareness.apply(entries)

      if (meta?.kind === 'yjs') {
        for (const entry of accepted) {
          if (entry.json === 'null') {
            meta.controlledIds = meta.controlledIds.filter((id) => id !== entry.clientId)
          } else if (!meta.controlledIds.includes(entry.clientId)) {
            meta.controlledIds.push(entry.clientId)
          }
        }
      }

      const out = this.awareness.encodeBatch(accepted)
      if (out) {
        for (const peerWs of this.ctx.getWebSockets('yjs')) {
          if (peerWs !== ws && peerWs.readyState === WebSocket.READY_STATE_OPEN) {
            try {
              peerWs.send(out)
            } catch {
              /* dead */
            }
          }
        }
      }
      return
    }

    if (type === MSG_QUERY_AWARENESS) {
      const snapshot = this.awareness.snapshot()
      if (snapshot) {
        try {
          ws.send(snapshot)
        } catch {
          /* ignore */
        }
      }
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = this.wsMeta.get(ws)
    this.wsMeta.delete(ws)

    if (meta?.kind === 'signal') {
      if (meta.peerId) {
        this.signaling.removePeer(meta.peerId, ws)
        this.signaling.broadcast({ type: 'bye', peerId: meta.peerId })
        this.signaling.broadcast({ type: 'peers', peers: this.signaling.publicPeers() })
      }
    } else if (meta?.kind === 'yjs') {
      if (meta.controlledIds.length > 0) {
        const retracted = this.awareness.retract(meta.controlledIds)
        const out = this.awareness.encodeBatch(retracted)
        if (out) {
          for (const peerWs of this.ctx.getWebSockets('yjs')) {
            if (peerWs.readyState === WebSocket.READY_STATE_OPEN) {
              try {
                peerWs.send(out)
              } catch {
                /* ignore */
              }
            }
          }
        }
      }

      // If all Yjs peers have left, persist immediate document snapshot
      if (this.ctx.getWebSockets('yjs').length === 0) {
        void this.roomStorage.saveDocument(this.doc)
      }
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }
}
