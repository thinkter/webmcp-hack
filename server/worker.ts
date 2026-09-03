/**
 * Cloudflare Worker entry point:
 * - Directs /yjs/:room and /signal/:room to the appropriate RoomDurableObject
 * - Provides /health check endpoint
 * - Serves frontend static assets via ASSETS binding with SPA fallback
 */

import { Env, RoomDurableObject } from './room-do'

export { RoomDurableObject }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const pathname = url.pathname

    // Health endpoint
    if (pathname === '/health' || pathname === '/healthz') {
      return Response.json({
        status: 'ok',
        service: 'webmcp-visual-yard',
        runtime: 'cloudflare-workers',
        timestamp: new Date().toISOString(),
      })
    }

    // Yjs websocket endpoint: /yjs or /yjs/:room
    if (pathname.startsWith('/yjs')) {
      const parts = pathname.split('/').filter(Boolean)
      const room = parts[1] || 'default'
      const stub = env.ROOM_DO.getByName(room)
      return stub.fetch(request)
    }

    // Signaling websocket endpoint: /signal or /signal/:room
    if (pathname.startsWith('/signal')) {
      const parts = pathname.split('/').filter(Boolean)
      const room = parts[1] || 'default'
      const stub = env.ROOM_DO.getByName(room)
      return stub.fetch(request)
    }

    // Static assets fallback (SPA routing)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    return new Response('WebMCP Visual Yard Worker Running', { status: 200 })
  },
}
