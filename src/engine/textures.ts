/**
 * Intermediate texture pool.
 *
 * A patch of thirty operators would otherwise allocate and destroy thirty
 * textures every frame. Instead each node borrows a texture for exactly as long
 * as a downstream node still needs to read it, then hands it back.
 */

/**
 * Half-float intermediates. Cheaper than 32-bit while still holding values
 * outside 0..1, which matters for bloom, additive compositing, and feedback
 * loops that would otherwise clip and lose their colour.
 */
export const RENDER_FORMAT: GPUTextureFormat = 'rgba16float'

const USAGE =
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.COPY_DST

const key = (width: number, height: number) => `${width}x${height}`

export class TexturePool {
  private readonly free = new Map<string, GPUTexture[]>()
  private readonly live = new Set<GPUTexture>()
  private placeholderTexture: GPUTexture | null = null
  private samplerCache = new Map<string, GPUSampler>()

  /** Textures created since the last `resetStats()`, for the diagnostics panel. */
  allocations = 0

  constructor(private readonly device: GPUDevice) {}

  acquire(width: number, height: number, label: string): GPUTexture {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    const bucket = this.free.get(key(w, h))
    const reused = bucket?.pop()

    if (reused) {
      this.live.add(reused)
      return reused
    }

    const texture = this.device.createTexture({
      label: `pool:${label}:${w}x${h}`,
      size: { width: w, height: h },
      format: RENDER_FORMAT,
      usage: USAGE,
    })
    this.allocations += 1
    this.live.add(texture)
    return texture
  }

  release(texture: GPUTexture | null | undefined): void {
    if (!texture || !this.live.delete(texture)) return
    const bucketKey = key(texture.width, texture.height)
    const bucket = this.free.get(bucketKey)
    if (bucket) bucket.push(texture)
    else this.free.set(bucketKey, [texture])
  }

  /**
   * 1x1 transparent black, bound to every texture slot an operator declares but
   * does not have wired. Keeping the bind group layout fixed this way means one
   * pipeline layout serves every operator.
   *
   * Composite operators rely on this being exactly 1x1 to detect an unwired
   * input via `textureDimensions`, so do not change the size.
   */
  placeholder(): GPUTexture {
    if (this.placeholderTexture) return this.placeholderTexture
    this.placeholderTexture = this.device.createTexture({
      label: 'placeholder:transparent',
      size: { width: 1, height: 1 },
      format: RENDER_FORMAT,
      usage: USAGE,
    })
    // rgba16float zero is transparent black; a fresh texture is already zeroed,
    // but clearing explicitly documents the intent and survives driver quirks.
    const encoder = this.device.createCommandEncoder({ label: 'clear-placeholder' })
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.placeholderTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.end()
    this.device.queue.submit([encoder.finish()])
    return this.placeholderTexture
  }

  sampler(addressMode: GPUAddressMode = 'clamp-to-edge', filter: GPUFilterMode = 'linear'): GPUSampler {
    const cacheKey = `${addressMode}:${filter}`
    const existing = this.samplerCache.get(cacheKey)
    if (existing) return existing
    const sampler = this.device.createSampler({
      label: `sampler:${cacheKey}`,
      addressModeU: addressMode,
      addressModeV: addressMode,
      magFilter: filter,
      minFilter: filter,
      mipmapFilter: 'nearest',
    })
    this.samplerCache.set(cacheKey, sampler)
    return sampler
  }

  /** Drops pooled textures that no longer match the current graph resolution. */
  trim(keepWidth: number, keepHeight: number): void {
    for (const [bucketKey, textures] of this.free) {
      const [w, h] = bucketKey.split('x').map(Number)
      // Half-resolution buckets are legitimate (bloom renders at scale 0.5), so
      // only discard buckets unrelated to the current resolution.
      const related =
        (w === keepWidth && h === keepHeight) ||
        (Math.abs(w * 2 - keepWidth) <= 2 && Math.abs(h * 2 - keepHeight) <= 2) ||
        (Math.abs(w * 4 - keepWidth) <= 4 && Math.abs(h * 4 - keepHeight) <= 4)
      if (related) continue
      for (const texture of textures) texture.destroy()
      this.free.delete(bucketKey)
    }
  }

  get stats(): { pooled: number; live: number; allocations: number } {
    let pooled = 0
    for (const textures of this.free.values()) pooled += textures.length
    return { pooled, live: this.live.size, allocations: this.allocations }
  }

  dispose(): void {
    for (const textures of this.free.values()) for (const texture of textures) texture.destroy()
    for (const texture of this.live) texture.destroy()
    this.placeholderTexture?.destroy()
    this.free.clear()
    this.live.clear()
    this.placeholderTexture = null
    this.samplerCache.clear()
  }
}
