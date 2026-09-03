# Cloudflare Unified Deployment Guide

This project is deployed to Cloudflare as a unified single-origin application combining:
- **Cloudflare Workers**: High-performance HTTP and WebSocket routing at the edge.
- **Cloudflare Workers Static Assets**: Ultra-fast global CDN delivery of the Vite React SPA, with automatic Single-Page Application (SPA) fallback for routes like `/join` and `/output`.
- **Cloudflare Durable Objects**: Stateful SQLite-backed rooms for real-time Yjs CRDT document synchronization and WebRTC peer signaling.

## Architecture

```
                  ┌─────────────────────────────────────────┐
                  │          Cloudflare Edge Network        │
                  │   (https://<your-worker>.workers.dev)   │
                  └────────────────────┬────────────────────┘
                                       │
                ┌──────────────────────┴──────────────────────┐
                │                                             │
      HTTP GET /assets/*, /*                        WebSocket Upgrade
                │                                             │
    ┌───────────▼───────────┐                     ┌───────────▼───────────┐
    │     Static Assets     │                     │     Worker Router     │
    │  (Vite SPA + Assets)  │                     │  (/yjs/* & /signal/*) │
    └───────────────────────┘                     └───────────┬───────────┘
                                                              │
                                                  ┌───────────▼───────────┐
                                                  │   RoomDurableObject   │
                                                  │  - Yjs CRDT sync      │
                                                  │  - WebRTC signaling   │
                                                  │  - SQLite persistence │
                                                  └───────────────────────┘
```

## Production Deployment

### Live Endpoint
- **URL**: [https://webmcp-visual-yard.ashmangamer0406.workers.dev](https://webmcp-visual-yard.ashmangamer0406.workers.dev)
- **Health Check**: [https://webmcp-visual-yard.ashmangamer0406.workers.dev/health](https://webmcp-visual-yard.ashmangamer0406.workers.dev/health)
- **Yjs WebSocket**: `wss://webmcp-visual-yard.ashmangamer0406.workers.dev/yjs/:room`
- **WebRTC Signaling**: `wss://webmcp-visual-yard.ashmangamer0406.workers.dev/signal/:room`

### Deployment Commands

To build and deploy updates:
```bash
npm run deploy
```

To test locally using the Miniflare / workerd runtime:
```bash
npm run preview:worker
```
