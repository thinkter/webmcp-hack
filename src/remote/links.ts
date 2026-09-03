/**
 * Deep links and QR codes for the phone/projector flow.
 *
 * Routes use query parameters (`/join?room=…&slot=…`) rather than path segments
 * so that no server rewrite rule is required: the room server's SPA fallback
 * and `vite preview` both serve `index.html` for `/join` without extra config,
 * and the client reads the params from `location.search`.
 */

import QRCode from 'qrcode'

const JOIN_PATH = '/join'
const OUTPUT_PATH = '/output'

/**
 * Origin the phone/projector should dial.
 *
 * Derived from `location.origin`, which is correct because the editor page is
 * itself loaded from the machine's LAN address.
 *
 * TRAP: if you open the editor at `http://localhost:5173`, every QR code below
 * encodes `localhost`, and the phone will resolve that to *itself* and show a
 * connection error that looks like a WebRTC bug. Always open the editor at the
 * LAN address printed by `server/index.mjs` (e.g. `http://192.168.1.20:5173`).
 * `warnIfUnreachableOrigin()` exists to make that failure loud.
 */
const origin = (): string => {
  if (typeof location === 'undefined') return 'http://localhost:5173'
  return location.origin
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i

/** True when the current page URL cannot possibly be reached by another device. */
export function isOriginPhoneReachable(): boolean {
  if (typeof location === 'undefined') return false
  return !LOOPBACK.test(location.hostname)
}

let warned = false
const warnIfUnreachableOrigin = (): void => {
  if (warned || isOriginPhoneReachable()) return
  warned = true
  console.warn(
    '[links] This page is served from a loopback address, so generated QR codes ' +
      'point at "localhost" and no phone can open them. Reload the editor using ' +
      'your machine\'s LAN IP (the room server prints it on startup).',
  )
}

const buildUrl = (path: string, room: string, slot: string): string => {
  const url = new URL(path, `${origin()}/`)
  url.searchParams.set('room', room)
  url.searchParams.set('slot', slot)
  return url.toString()
}

/** Absolute URL a phone opens to publish a camera into `slot`. */
export function joinUrl(room: string, slot: string): string {
  warnIfUnreachableOrigin()
  return buildUrl(JOIN_PATH, room, slot)
}

/** Absolute URL a projector opens to display output `slot`. */
export function outputUrl(room: string, slot: string): string {
  warnIfUnreachableOrigin()
  return buildUrl(OUTPUT_PATH, room, slot)
}

/**
 * Light modules on a dark background, to sit inside the dark editor chrome
 * without a glaring white card. Inverted QR codes are read fine by the iOS
 * Camera app and Google Lens; if a stubborn scanner refuses, swap `dark` and
 * `light` below.
 */
const QR_LIGHT_ON_DARK = { dark: '#e8ecffff', light: '#0b0e14ff' } as const

/** PNG data URL for a QR code, sized for on-screen scanning. */
export async function qrDataUrl(url: string, size = 320): Promise<string> {
  return QRCode.toDataURL(url, {
    type: 'image/png',
    // 'H' survives a phone camera at an angle, in bad light, on a glossy screen.
    errorCorrectionLevel: 'H',
    // Two modules of quiet zone is the spec minimum that still scans reliably.
    margin: 2,
    width: Math.max(128, Math.round(size)),
    color: { ...QR_LIGHT_ON_DARK },
  })
}

/**
 * Crockford-ish alphabet: no 0/O, no 1/I/L, so a room code can be read off a
 * projector and typed into a phone without ambiguity.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const ROOM_CODE_LENGTH = 6

/** Short, unambiguous, human-typeable room code (no 0/O/1/I/l). */
export function generateRoomCode(): string {
  const n = ALPHABET.length
  const out: string[] = []
  const c = globalThis.crypto

  if (typeof c?.getRandomValues === 'function') {
    // Rejection sampling: 256 % 31 !== 0, so naive modulo would bias the first
    // few letters. Codes are shown to humans and typed back; keep them uniform.
    const limit = Math.floor(256 / n) * n
    const buf = new Uint8Array(ROOM_CODE_LENGTH * 2)
    while (out.length < ROOM_CODE_LENGTH) {
      c.getRandomValues(buf)
      for (const byte of buf) {
        if (byte >= limit) continue
        out.push(ALPHABET[byte % n])
        if (out.length === ROOM_CODE_LENGTH) break
      }
    }
  } else {
    while (out.length < ROOM_CODE_LENGTH) {
      out.push(ALPHABET[Math.floor(Math.random() * n)])
    }
  }

  return out.join('')
}

/** Read `room`/`slot` back out of a `/join` or `/output` URL. */
export function parseRoomParams(search: string = typeof location === 'undefined' ? '' : location.search): {
  room: string | null
  slot: string | null
} {
  const params = new URLSearchParams(search)
  const room = params.get('room')
  const slot = params.get('slot')
  return {
    room: room !== null && room.length > 0 ? room : null,
    slot: slot !== null && slot.length > 0 ? slot : null,
  }
}
