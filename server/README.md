# Room server

One Node process, one port, three jobs. Runtime deps: `ws`, `yjs`, node builtins.

```
node server/index.mjs           # defaults to 0.0.0.0:8787
PORT=9000 node server/index.mjs
HOST=127.0.0.1 node server/index.mjs
```

On startup it prints every non-internal IPv4 address with ready-made URLs. **Use
one of those, not `localhost`** — see "The localhost trap" below.

## Endpoints

| Endpoint | Protocol | Purpose |
| --- | --- | --- |
| `ws://host:8787/yjs/<room>` | y-websocket binary | Collaborative graph sync between editors |
| `ws://host:8787/signal/<room>` | JSON | WebRTC signaling relay (phone camera, projector output) |
| `GET /health` | JSON | uptime, room count, per-room peer counts |
| `GET /*` | HTTP | static `dist/`, SPA fallback to `index.html` |

Room names are a single path segment, max 120 chars, URL-encoded.

### Yjs sync

The y-websocket wire protocol is re-implemented in-file (varint codec + three
message shapes) rather than imported, so the server does not depend on
`y-protocols`/`lib0`. Compatible with the stock `y-websocket` `WebsocketProvider`.

* `Y.Doc` per room is held in memory and is authoritative, so a late joiner gets
  current state (it sends sync step 1 on open, we answer with step 2).
* Awareness (cursors, presence) is mirrored per room so late joiners see existing
  peers, and a closing socket's awareness state is retracted on its behalf.
* Message types handled: `0` sync (steps 0/1/2), `1` awareness, `3` query
  awareness. `2` (auth) is ignored — this server is open by design.
* **Not persisted.** When the last client in a room disconnects, the room's
  `Y.Doc` is destroyed. Restarting the server loses every graph. Fine for a
  demo; if you need persistence, add `y-leveldb` or write the doc to disk in
  `YRoom`'s `update` handler.

### Signaling

A dumb mailbox. It never parses SDP or ICE.

```jsonc
// client -> server
{ "type": "hello",  "peerId": "a1b2c3d4", "role": "editor|publisher|display", "slot": "cam1", "label": "Pixel 8" }
{ "type": "signal", "to": "<peerId>", "payload": <anything> }

// server -> client
{ "type": "peers",       "peers": [{ "peerId", "role", "slot", "label" }, ...] }  // on every membership change
{ "type": "signal",      "to": "<peerId>", "from": "<peerId>", "payload": <anything> }
{ "type": "bye",         "peerId": "<peerId>" }
{ "type": "unreachable", "peerId": "<peerId>" }  // you addressed a peer that left
```

`from` is always overwritten with the sender's connection-bound `peerId`, so a
peer cannot impersonate another. A `hello` reusing an existing `peerId` evicts
the older socket (close code `4000`), which is what a reconnecting phone does.
Signaling payload cap is 512 KB.

### Static serving

Serves `dist/` if present. Extension-less paths that don't exist fall back to
`index.html`, so client-side routes `/join` and `/output` work with no rewrite
rules. `assets/*` is served `immutable`; everything else `no-cache`. Path
traversal is rejected. If `dist/` is absent, every non-`/health` request returns
`503` with plain-text instructions (`npm run build`, or use `npm run dev`).

## Operations

* **Heartbeat** — 30 s ping on both WS servers; sockets that miss a pong are
  terminated. Phones sleep and Wi-Fi drops, and a half-open socket would
  otherwise leave a ghost peer in the room forever.
* **Room GC** — rooms are deleted when their last socket closes.
* **Graceful shutdown** — `SIGINT`/`SIGTERM` close all sockets with `1001`,
  destroy docs, close the HTTP server; hard exit after 3 s if a keep-alive
  connection lingers.
* **Bind address** — `0.0.0.0` by default. Required: the phone connects from
  another device.
* **`EADDRINUSE`** exits with a one-line explanation instead of a stack trace.
* **Logs** — every join/leave on both endpoints, plus malformed-message warnings.
  Quiet enough to watch during a demo.

## The localhost trap

The QR code shown in the editor is built from `location.origin`. If you open the
editor at `http://localhost:5173`, the QR encodes `localhost`, the phone resolves
that to *itself*, and you get a failure that looks like a WebRTC bug but isn't.

Always open the editor at the LAN address the banner prints, e.g.
`http://192.168.1.20:5173`.

## Two ways to run

**Dev (two processes)**

```
node server/index.mjs      # :8787  sync + signaling
npm run dev -- --host      # :5173  UI with HMR  (--host is required for phones)
```

The browser code auto-targets port 8787 when the page is served from 5173/4173
(see `resolveServerUrl()` in `src/remote/signal.ts`).

**Production (one process)**

```
npm run build
node server/index.mjs      # :8787 serves UI + sync + signaling from one origin
```

## Firewall / network gotchas

* Ports **8787** and **5173** must be reachable from the phone. On Linux:
  `sudo ufw allow 8787/tcp 5173/tcp` (or disable the firewall for the demo).
* **Guest / captive Wi-Fi with client isolation blocks this entirely** — devices
  cannot see each other, so neither the HTTP fetch nor the WebRTC host candidates
  work. Use a phone hotspot with the laptop joined to it.
* `getUserMedia` on the phone needs a **secure context**: `https://` or
  `http://localhost`. A plain `http://192.168.x.x` origin will *not* prompt for
  camera access in Chrome or Safari. Options, cheapest first:
  1. Chrome on Android → `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
     add `http://192.168.x.x:5173`.
  2. Run a tunnel (`cloudflared tunnel --url http://localhost:5173`) and set
     `window.__ROOM_SERVER_URL__` to the tunnel's `wss://` origin.
  3. Serve the whole thing over TLS with a self-signed cert / `mkcert`.
* No TURN server is configured. Phone-and-laptop-on-one-Wi-Fi connects on host
  candidates; anything crossing a real NAT (phone on cellular) will not connect.
