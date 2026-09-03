#!/usr/bin/env node
/**
 * Room server for the live visual tool. One process, one port, three jobs:
 *
 *   1. `ws://host:port/yjs/<room>`     — Yjs document sync (y-websocket wire protocol)
 *   2. `ws://host:port/signal/<room>`  — WebRTC signaling relay (opaque payloads)
 *   3. `http://host:port/*`            — static `dist/` with SPA fallback
 *
 * Runtime dependencies are deliberately minimal: `ws`, `yjs`, and node builtins.
 * The y-websocket binary protocol is re-implemented here (a ~120 line varint
 * codec plus three message shapes) so we do not pull `y-protocols`/`lib0` into
 * the server process, and so the framing is readable in one file.
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocketServer } from 'ws'
import * as Y from 'yjs'

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const HOST = process.env.HOST ?? '0.0.0.0'
const HEARTBEAT_MS = 30_000
const STARTED_AT = Date.now()

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const DIST_DIR = resolve(PROJECT_ROOT, 'dist')

const WS_OPEN = 1

// ---------------------------------------------------------------------------
// Minimal lib0-compatible varint codec
//
// Every integer on the y-websocket wire is an unsigned LEB128 varint; every
// byte array and string is that varint (a length) followed by raw bytes. That
// is the whole format, so a hand-rolled writer/reader pair is enough to speak
// it. `%`/`Math.floor` rather than bit ops because Yjs clientIDs are random
// uint32 values and JS bitwise operators truncate to int32.
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

class Writer {
  constructor() {
    this.buf = new Uint8Array(256)
    this.len = 0
  }

  ensure(extra) {
    const needed = this.len + extra
    if (needed <= this.buf.length) return
    let cap = this.buf.length
    while (cap < needed) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  varUint(value) {
    let n = value
    this.ensure(10)
    while (n > 127) {
      this.buf[this.len++] = 128 | (n % 128)
      n = Math.floor(n / 128)
    }
    this.buf[this.len++] = n % 128
    return this
  }

  varBytes(bytes) {
    this.varUint(bytes.length)
    this.ensure(bytes.length)
    this.buf.set(bytes, this.len)
    this.len += bytes.length
    return this
  }

  varString(str) {
    return this.varBytes(textEncoder.encode(str))
  }

  finish() {
    return this.buf.slice(0, this.len)
  }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes
    this.pos = 0
  }

  get hasMore() {
    return this.pos < this.bytes.length
  }

  byte() {
    if (this.pos >= this.bytes.length) throw new RangeError('unexpected end of message')
    return this.bytes[this.pos++]
  }

  varUint() {
    let value = 0
    let mult = 1
    for (let i = 0; i < 8; i++) {
      const b = this.byte()
      value += (b & 127) * mult
      if (b < 128) return value
      mult *= 128
    }
    throw new RangeError('varint too long')
  }

  varBytes() {
    const len = this.varUint()
    if (this.pos + len > this.bytes.length) throw new RangeError('varBytes overruns message')
    const out = this.bytes.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  varString() {
    return textDecoder.decode(this.varBytes())
  }
}

/** Normalise whatever `ws` handed us into a single Uint8Array view. */
const toBytes = (data) => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(0)
}

// ---------------------------------------------------------------------------
// y-websocket message shapes
// ---------------------------------------------------------------------------

const MSG_SYNC = 0
const MSG_AWARENESS = 1
const MSG_QUERY_AWARENESS = 3

const SYNC_STEP_1 = 0
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2

const encodeSync = (step, payload) => new Writer().varUint(MSG_SYNC).varUint(step).varBytes(payload).finish()
const encodeAwareness = (payload) => new Writer().varUint(MSG_AWARENESS).varBytes(payload).finish()

const send = (socket, bytes) => {
  if (socket.readyState !== WS_OPEN) return
  try {
    socket.send(bytes)
  } catch {
    // A socket that rejects a write is already gone; the close handler cleans up.
    try {
      socket.terminate()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Yjs rooms
// ---------------------------------------------------------------------------

/** @type {Map<string, YRoom>} */
const yRooms = new Map()

class YRoom {
  constructor(name) {
    this.name = name
    this.doc = new Y.Doc()
    /** @type {Set<import('ws').WebSocket>} */
    this.sockets = new Set()
    /**
     * Awareness store, mirroring y-protocols semantics well enough that a late
     * joiner sees everyone's cursors/selection instead of an empty room.
     * `json === 'null'` marks a removed client whose clock we still remember,
     * so a stale re-broadcast cannot resurrect it.
     * @type {Map<number, { clock: number, json: string }>}
     */
    this.awareness = new Map()

    this.doc.on('update', (update, origin) => {
      const message = encodeSync(SYNC_UPDATE, update)
      for (const socket of this.sockets) {
        if (socket !== origin) send(socket, message)
      }
    })
  }

  /** Full awareness snapshot for a socket that just joined. */
  awarenessSnapshot() {
    const live = [...this.awareness.entries()].filter(([, entry]) => entry.json !== 'null')
    if (live.length === 0) return null
    const w = new Writer().varUint(live.length)
    for (const [clientId, entry] of live) {
      w.varUint(clientId).varUint(entry.clock).varString(entry.json)
    }
    return encodeAwareness(w.finish())
  }

  broadcastAwareness(entries, except) {
    if (entries.length === 0) return
    const w = new Writer().varUint(entries.length)
    for (const entry of entries) {
      w.varUint(entry.clientId).varUint(entry.clock).varString(entry.json)
    }
    const message = encodeAwareness(w.finish())
    for (const socket of this.sockets) {
      if (socket !== except) send(socket, message)
    }
  }
}

const yRoomFor = (name) => {
  const existing = yRooms.get(name)
  if (existing) return existing
  const room = new YRoom(name)
  yRooms.set(name, room)
  return room
}

const handleYjsMessage = (room, socket, bytes) => {
  const reader = new Reader(bytes)
  const type = reader.varUint()

  if (type === MSG_SYNC) {
    const step = reader.varUint()
    if (step === SYNC_STEP_1) {
      // Peer told us what it has; hand back everything it is missing.
      send(socket, encodeSync(SYNC_STEP_2, Y.encodeStateAsUpdate(room.doc, reader.varBytes())))
    } else if (step === SYNC_STEP_2 || step === SYNC_UPDATE) {
      // `socket` as origin keeps the fan-out from echoing back to the sender.
      Y.applyUpdate(room.doc, reader.varBytes(), socket)
    }
    return
  }

  if (type === MSG_AWARENESS) {
    const payload = reader.varBytes()
    const inner = new Reader(payload)
    const count = inner.varUint()
    const accepted = []
    for (let i = 0; i < count; i++) {
      const clientId = inner.varUint()
      const clock = inner.varUint()
      const json = inner.varString()
      const prev = room.awareness.get(clientId)
      const removal = json === 'null'
      const fresh =
        prev === undefined ||
        clock > prev.clock ||
        (clock === prev.clock && removal && prev.json !== 'null')
      if (!fresh) continue
      room.awareness.set(clientId, { clock, json })
      if (removal) socket.controlledIds?.delete(clientId)
      else socket.controlledIds?.add(clientId)
      accepted.push({ clientId, clock, json })
    }
    room.broadcastAwareness(accepted, socket)
    return
  }

  if (type === MSG_QUERY_AWARENESS) {
    const snapshot = room.awarenessSnapshot()
    if (snapshot) send(socket, snapshot)
  }

  // Unknown types (e.g. auth) are ignored on purpose: this server is open.
}

const setupYjsConnection = (socket, roomName) => {
  const room = yRoomFor(roomName)
  socket.controlledIds = new Set()
  room.sockets.add(socket)

  socket.on('message', (data) => {
    try {
      handleYjsMessage(room, socket, toBytes(data))
    } catch (err) {
      console.warn(`[yjs:${roomName}] dropped malformed message:`, err instanceof Error ? err.message : err)
    }
  })

  socket.on('close', () => {
    room.sockets.delete(socket)

    // Retract this client's awareness state so other peers stop drawing a
    // cursor for a browser tab that closed.
    const retracted = []
    for (const clientId of socket.controlledIds ?? []) {
      const prev = room.awareness.get(clientId)
      const clock = (prev?.clock ?? 0) + 1
      room.awareness.set(clientId, { clock, json: 'null' })
      retracted.push({ clientId, clock, json: 'null' })
    }
    room.broadcastAwareness(retracted, socket)

    if (room.sockets.size === 0) {
      room.doc.destroy()
      yRooms.delete(roomName)
      console.log(`[yjs:${roomName}] room empty, released`)
    }
  })

  // Standard handshake: we advertise our state vector, the client replies with
  // step 2 and its own step 1, and we answer that with our full state.
  send(socket, encodeSync(SYNC_STEP_1, Y.encodeStateVector(room.doc)))
  const snapshot = room.awarenessSnapshot()
  if (snapshot) send(socket, snapshot)

  console.log(`[yjs:${roomName}] client joined (${room.sockets.size} in room)`)
}

// ---------------------------------------------------------------------------
// WebRTC signaling rooms
//
// Strictly a mailbox. SDP and ICE payloads are forwarded verbatim and never
// inspected — the server has no opinion about codecs, candidates, or topology.
// ---------------------------------------------------------------------------

/** @type {Map<string, Map<string, { peerId: string, role: string, slot: string, label: string, socket: import('ws').WebSocket }>>} */
const signalRooms = new Map()

const ROLES = new Set(['editor', 'publisher', 'display'])

const asShortString = (value, fallback = '') =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : fallback

const signalRoomFor = (name) => {
  const existing = signalRooms.get(name)
  if (existing) return existing
  const room = new Map()
  signalRooms.set(name, room)
  return room
}

const publicPeers = (room) =>
  [...room.values()].map(({ peerId, role, slot, label }) => ({ peerId, role, slot, label }))

const sendJson = (socket, value) => {
  if (socket.readyState !== WS_OPEN) return
  try {
    socket.send(JSON.stringify(value))
  } catch {
    /* dead socket; close handler cleans up */
  }
}

const broadcastPeers = (room) => {
  const message = JSON.stringify({ type: 'peers', peers: publicPeers(room) })
  for (const peer of room.values()) {
    if (peer.socket.readyState === WS_OPEN) peer.socket.send(message)
  }
}

const setupSignalConnection = (socket, roomName) => {
  const room = signalRoomFor(roomName)
  /** @type {string | null} */
  let peerId = null

  socket.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(textDecoder.decode(toBytes(data)))
    } catch {
      return
    }
    if (msg === null || typeof msg !== 'object') return

    if (msg.type === 'hello') {
      const id = asShortString(msg.peerId)
      if (id === '') return
      // A reconnecting peer reuses its id; replace the stale entry.
      const stale = room.get(id)
      if (stale && stale.socket !== socket) {
        try {
          stale.socket.close(4000, 'replaced by newer connection')
        } catch {
          /* ignore */
        }
      }
      const peer = {
        peerId: id,
        role: ROLES.has(msg.role) ? msg.role : 'editor',
        slot: asShortString(msg.slot),
        label: asShortString(msg.label),
        socket,
      }
      peerId = id
      room.set(id, peer)
      console.log(`[signal:${roomName}] hello ${id} (${peer.role}/${peer.slot || '-'})`)
      broadcastPeers(room)
      return
    }

    if (msg.type === 'signal') {
      const to = asShortString(msg.to)
      if (to === '' || peerId === null) return
      const target = room.get(to)
      if (!target) {
        sendJson(socket, { type: 'unreachable', peerId: to })
        return
      }
      // `from` is overwritten with the authenticated-by-connection id so a peer
      // cannot spoof another peer. `payload` is passed through untouched.
      sendJson(target.socket, { type: 'signal', to, from: peerId, payload: msg.payload })
      return
    }

    if (msg.type === 'bye') {
      try {
        socket.close(1000, 'client said bye')
      } catch {
        /* ignore */
      }
    }
  })

  socket.on('close', () => {
    if (peerId !== null && room.get(peerId)?.socket === socket) {
      room.delete(peerId)
      const message = JSON.stringify({ type: 'bye', peerId })
      for (const peer of room.values()) {
        if (peer.socket.readyState === WS_OPEN) peer.socket.send(message)
      }
      broadcastPeers(room)
      console.log(`[signal:${roomName}] bye ${peerId} (${room.size} left)`)
    }
    if (room.size === 0) {
      signalRooms.delete(roomName)
    }
  })

  // Current membership, so a fresh peer can start offering immediately.
  sendJson(socket, { type: 'peers', peers: publicPeers(room) })
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wgsl': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

// The client hardcodes 8787 for the dev (two-process) setup, so a non-default
// PORT needs the documented override or the browser will dial the wrong place.
const PORT_NOTE =
  PORT === 8787
    ? ''
    : `
     NOTE: the client defaults to port 8787 in dev. This server is on ${PORT}, so set
     window.__ROOM_SERVER_URL__ = "ws://<lan-ip>:${PORT}" before the app loads.`

const NO_DIST_MESSAGE = `This is the room server (Yjs sync + WebRTC signaling). It has no UI bundle to serve.

Looked for: ${join(DIST_DIR, 'index.html')}

Pick one:
  1) Development — run the Vite dev server and open that instead:
       npm run dev -- --host       # http://<your-lan-ip>:5173
     Keep this server running; the browser connects to port ${PORT} for /yjs and /signal.${PORT_NOTE}

  2) Production — build once, then everything is served from this port:
       npm run build
       node server/index.mjs

Endpoints that work right now:
  GET  /health
  WS   /yjs/<room>
  WS   /signal/<room>
`

/** An empty or half-built `dist/` counts as absent — `index.html` is the tell. */
const distExists = async () => {
  try {
    return (await stat(join(DIST_DIR, 'index.html'))).isFile()
  } catch {
    return false
  }
}

/** Resolve a URL pathname to a file inside dist, or null if it escapes. */
const safeDistPath = (pathname) => {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname)
    } catch {
      return null
    }
  })()
  if (decoded === null) return null
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const full = join(DIST_DIR, relative)
  if (full !== DIST_DIR && !full.startsWith(DIST_DIR + sep)) return null
  return full
}

const tryReadFile = async (path) => {
  try {
    if (!(await stat(path)).isFile()) return null
    return await readFile(path)
  } catch {
    return null
  }
}

const serveStatic = async (req, res, pathname) => {
  if (!(await distExists())) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(NO_DIST_MESSAGE)
    return
  }

  const candidate = safeDistPath(pathname === '/' ? '/index.html' : pathname)
  if (candidate === null) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }

  let path = candidate
  let body = await tryReadFile(path)

  if (body === null && extname(path) === '') {
    // SPA fallback: /join and /output are client-side routes.
    path = join(DIST_DIR, 'index.html')
    body = await tryReadFile(path)
  }

  if (body === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }

  const ext = extname(path)
  const immutable = path.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': body.byteLength,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

// ---------------------------------------------------------------------------
// HTTP + upgrade wiring
// ---------------------------------------------------------------------------

const yjsWss = new WebSocketServer({ noServer: true })
// SDP blobs are a few KB; a small cap keeps the signaling path from being used
// as a general-purpose data relay.
const signalWss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 })

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('Method not allowed')
    return
  }

  if (url.pathname === '/health') {
    const rooms = {}
    for (const [name, room] of signalRooms) {
      rooms[name] = { ...(rooms[name] ?? {}), signalPeers: room.size }
    }
    for (const [name, room] of yRooms) {
      rooms[name] = { ...(rooms[name] ?? {}), yjsClients: room.sockets.size }
    }
    const body = JSON.stringify(
      {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
        port: PORT,
        roomCount: Object.keys(rooms).length,
        rooms,
      },
      null,
      2,
    )
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }

  serveStatic(req, res, url.pathname).catch((err) => {
    console.error('[http] static handler failed:', err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Internal server error')
  })
})

/** `/yjs/<room>` and `/signal/<room>`; room may contain slashes-free text only. */
const parseWsPath = (pathname) => {
  const match = /^\/(yjs|signal)\/([^/]{1,120})\/?$/.exec(pathname)
  if (match === null) return null
  const room = decodeURIComponent(match[2])
  if (room.length === 0) return null
  return { kind: match[1], room }
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const route = parseWsPath(url.pathname)

  if (route === null) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  const wss = route.kind === 'yjs' ? yjsWss : signalWss
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })
    ws.on('error', (err) => {
      console.warn(`[${route.kind}:${route.room}] socket error:`, err instanceof Error ? err.message : err)
    })
    if (route.kind === 'yjs') setupYjsConnection(ws, route.room)
    else setupSignalConnection(ws, route.room)
  })
})

// Heartbeat: phones sleep, Wi-Fi drops, and a half-open socket otherwise keeps
// a ghost peer in the room forever.
const heartbeat = setInterval(() => {
  for (const wss of [yjsWss, signalWss]) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }
  }
}, HEARTBEAT_MS)
heartbeat.unref?.()

// ---------------------------------------------------------------------------
// Startup banner
//
// Finding the machine's LAN address is the single most annoying part of the
// phone-camera demo, so print every reachable URL rather than making anyone
// run `ip addr`.
// ---------------------------------------------------------------------------

const lanAddresses = () => {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      out.push({ name, address: addr.address })
    }
  }
  return out
}

const printBanner = async () => {
  const hasDist = await distExists()
  const lan = lanAddresses()

  console.log('')
  console.log(`  room server listening on ${HOST}:${PORT}`)
  console.log(`  static bundle: ${hasDist ? DIST_DIR : 'not built (run `npm run build`, or use `npm run dev`)'}`)
  console.log('')

  if (lan.length === 0) {
    console.log('  no non-internal IPv4 interface found — a phone will not be able to reach this host.')
    console.log('  connect this machine to Wi-Fi/Ethernet and restart.')
  } else {
    console.log('  open the editor from one of these (NOT localhost — the QR code is')
    console.log('  derived from the page URL, and a phone cannot resolve localhost):')
    console.log('')
    for (const { name, address } of lan) {
      const base = hasDist ? `http://${address}:${PORT}` : `http://${address}:5173`
      console.log(`    ${name.padEnd(10)} ${base}/`)
      console.log(`    ${' '.repeat(10)} ${base}/join?room=<ROOM>&slot=cam1     (phone camera)`)
      console.log(`    ${' '.repeat(10)} ${base}/output?room=<ROOM>&slot=main   (projector)`)
      console.log('')
    }
    console.log(`  signaling/sync always lives on port ${PORT}:`)
    console.log(`    ws://${lan[0].address}:${PORT}/signal/<ROOM>`)
    console.log(`    ws://${lan[0].address}:${PORT}/yjs/<ROOM>`)
  }
  console.log('')
  console.log(`  health: http://localhost:${PORT}/health`)
  console.log('')
}

httpServer.listen(PORT, HOST, () => {
  printBanner().catch((err) => console.error('[boot] banner failed:', err))
})

httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[boot] port ${PORT} is already in use. Stop the other process or run with PORT=<other>.`)
    process.exit(1)
  }
  console.error('[boot] server error:', err)
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[shutdown] ${signal} received, closing…`)
  clearInterval(heartbeat)

  for (const wss of [yjsWss, signalWss]) {
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'server shutting down')
      } catch {
        /* ignore */
      }
    }
    wss.close()
  }

  for (const room of yRooms.values()) room.doc.destroy()
  yRooms.clear()
  signalRooms.clear()

  httpServer.close(() => {
    console.log('[shutdown] done')
    process.exit(0)
  })

  // Don't let a lingering keep-alive connection hold the process open.
  setTimeout(() => {
    console.warn('[shutdown] forced exit after 3s')
    process.exit(0)
  }, 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason)
})
