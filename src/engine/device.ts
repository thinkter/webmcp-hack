/**
 * WebGPU device acquisition.
 *
 * A single device is shared by the whole application: the program monitor, every
 * node thumbnail, and any projector window all render from it, because textures
 * cannot be shared across devices.
 */

export type GpuContext = {
  adapter: GPUAdapter
  device: GPUDevice
  /** Preferred format for canvas surfaces. */
  canvasFormat: GPUTextureFormat
}

export class GpuUnavailableError extends Error {
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = 'GpuUnavailableError'
    this.hint = hint
  }
}

let pending: Promise<GpuContext> | null = null
let current: GpuContext | null = null
const lostListeners = new Set<(reason: string) => void>()

export function onDeviceLost(listener: (reason: string) => void): () => void {
  lostListeners.add(listener)
  return () => lostListeners.delete(listener)
}

export function peekGpu(): GpuContext | null {
  return current
}

export function requestGpu(): Promise<GpuContext> {
  if (pending) return pending

  pending = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      throw new GpuUnavailableError(
        'This browser does not expose WebGPU.',
        'Use Chrome or Edge 113+, Safari 18+, or Firefox with WebGPU enabled. On Linux you may need to launch Chrome with --enable-unsafe-webgpu --enable-features=Vulkan.',
      )
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) {
      throw new GpuUnavailableError(
        'No WebGPU adapter is available.',
        'The browser supports WebGPU but could not reach a GPU. Check that hardware acceleration is enabled.',
      )
    }

    const device = await adapter.requestDevice({
      label: 'visual-engine',
      // Larger intermediate textures than the default are routine at 1080p.
      requiredLimits: {
        maxTextureDimension2D: Math.min(4096, adapter.limits.maxTextureDimension2D),
      },
    })

    device.lost.then((info) => {
      const reason = info.message || info.reason || 'unknown'
      current = null
      pending = null
      for (const listener of lostListeners) listener(reason)
    })

    // Surface validation problems in the console rather than silently rendering
    // black; without this, a single bad bind group is very hard to track down.
    device.addEventListener('uncapturederror', (event) => {
      const detail = (event as GPUUncapturedErrorEvent).error
      console.error('[webgpu] uncaptured error:', detail.message)
    })

    const context: GpuContext = {
      adapter,
      device,
      canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
    }
    current = context
    return context
  })()

  pending.catch(() => {
    pending = null
  })

  return pending
}

/** Human-readable adapter summary for the status bar and WebMCP health reports. */
export function describeAdapter(context: GpuContext): string {
  const info = context.adapter.info as GPUAdapterInfo | undefined
  if (!info) return 'WebGPU adapter'
  const parts = [info.vendor, info.architecture, info.device].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'WebGPU adapter'
}
