/**
 * The render engine.
 *
 * One `requestAnimationFrame` loop drives everything: signals are evaluated,
 * external media is uploaded, the texture graph is executed in dependency
 * order, and then every attached surface — the program monitor, the per-node
 * thumbnails, a projector window — is drawn from the results.
 *
 * Only nodes whose pixels somebody actually wants are executed, so a large
 * patch with one visible output costs no more than the chain feeding it.
 */

import { ancestorsOf, buildPlan, type Plan, type PlanIssue } from './compile'
import { describeAdapter, onDeviceLost, requestGpu, type GpuContext } from './device'
import { MediaRegistry } from './media'
import { PipelineCache, type CompiledOperator, type ShaderError } from './pipelines'
import { SignalRuntime } from './signals'
import { RENDER_FORMAT, TexturePool } from './textures'
import { UNIFORM_FLOATS } from './wgsl/prelude'
import { getOperator } from './ops'
import type { OperatorSpec } from './ops/kit'
import { resolveParams, usePatchStore } from '../graph/store'
import type { ParamValue, PatchNode, Resolution } from '../graph/types'
import { mediaHub } from '../remote/hub'

export type EngineState = 'idle' | 'starting' | 'running' | 'error'

export type SurfaceTarget =
  | { kind: 'output'; nodeId: string }
  | { kind: 'node'; nodeId: string }

export type EngineStatus = {
  state: EngineState
  error: string | null
  hint: string | null
  adapter: string | null
  /** Smoothed frames per second actually achieved. */
  fps: number
  /** Wall-clock milliseconds spent building and submitting the last frame. */
  frameMs: number
  executedNodes: number
  resolution: Resolution
  issues: PlanIssue[]
  /** Compile diagnostics for Custom WGSL nodes, keyed by node id. */
  shaderErrors: Map<string, ShaderError[]>
  textures: { pooled: number; live: number; allocations: number }
  pipelines: number
}

type Surface = {
  id: number
  canvas: HTMLCanvasElement
  context: GPUCanvasContext
  target: SurfaceTarget
  minIntervalMs: number
  lastDrawn: number
  configured: boolean
}

/** Header floats written ahead of the 48 parameter slots. */
const HEADER_FLOATS = 8

let surfaceCounter = 0

class RenderEngine {
  private gpu: GpuContext | null = null
  private pool: TexturePool | null = null
  private pipelines: PipelineCache | null = null
  private media: MediaRegistry | null = null
  private readonly signals = new SignalRuntime()

  private plan: Plan | null = null
  private planSignature = ''

  private frameHandle: number | null = null
  private stopped = false
  private startPromise: Promise<void> | null = null
  private deviceLostCleanup: (() => void) | null = null
  private mediaSubscription: (() => void) | null = null

  private readonly surfaces = new Map<number, Surface>()
  private readonly uniformBuffers = new Map<string, GPUBuffer[]>()
  private readonly history = new Map<string, GPUTexture>()
  private readonly customOperators = new Map<string, CompiledOperator>()
  private readonly customSources = new Map<string, string>()
  private readonly customPending = new Set<string>()

  private readonly scratch = new Float32Array(HEADER_FLOATS + UNIFORM_FLOATS)
  private nodeTextures = new Map<string, GPUTexture>()

  private lastTime = 0
  private timeline = 0
  private frameCount = 0
  private fpsAccumulator = 0
  private fpsFrames = 0

  private status: EngineStatus = {
    state: 'idle',
    error: null,
    hint: null,
    adapter: null,
    fps: 0,
    frameMs: 0,
    executedNodes: 0,
    resolution: { width: 1280, height: 720 },
    issues: [],
    shaderErrors: new Map(),
    textures: { pooled: 0, live: 0, allocations: 0 },
    pipelines: 0,
  }

  private readonly listeners = new Set<() => void>()
  private statusDirty = false

  // ------------------------------------------------------------ lifecycle ----

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getStatus(): EngineStatus {
    return this.status
  }

  private publish(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch }
    this.statusDirty = true
  }

  private flushStatus(): void {
    if (!this.statusDirty) return
    this.statusDirty = false
    for (const listener of this.listeners) listener()
  }

  async start(): Promise<void> {
    this.stopped = false
    if (this.startPromise) return this.startPromise
    if (this.gpu && this.pool && this.pipelines && this.media && this.status.state === 'running') {
      if (this.frameHandle === null) {
        this.loop(performance.now())
      }
      return
    }

    this.startPromise = (async () => {
      this.publish({ state: 'starting', error: null, hint: null })
      this.flushStatus()

      try {
        if (!this.gpu) {
          const gpu = await requestGpu()
          this.gpu = gpu
          this.deviceLostCleanup?.()
          this.deviceLostCleanup = onDeviceLost((reason) => {
            this.gpu = null
            this.mediaSubscription?.()
            this.mediaSubscription = null
            this.media?.dispose()
            this.media = null
            this.pool?.dispose()
            this.pool = null
            this.pipelines = null
            this.publish({
              state: 'error',
              error: `The GPU device was lost: ${reason}`,
              hint: 'Reload the page. If this repeats, a shader may be too heavy for this GPU — try a lower resolution.',
            })
            this.flushStatus()
          })
        }

        if (this.stopped) {
          this.publish({ state: 'idle', fps: 0, frameMs: 0, executedNodes: 0 })
          this.flushStatus()
          return
        }

        if (!this.pool) {
          this.pool = new TexturePool(this.gpu.device)
        }
        if (!this.pipelines) {
          this.pipelines = new PipelineCache(this.gpu.device)
        }
        if (!this.media) {
          this.media = new MediaRegistry(this.gpu.device)
          this.mediaSubscription?.()
          this.mediaSubscription = this.media.subscribe(() => this.flushStatus())
        }

        this.publish({ state: 'running', adapter: describeAdapter(this.gpu) })
        this.flushStatus()
        if (this.frameHandle === null) {
          this.loop(performance.now())
        }
      } catch (reason) {
        const hint =
          reason && typeof reason === 'object' && 'hint' in reason
            ? String((reason as { hint: unknown }).hint)
            : null
        this.publish({
          state: 'error',
          error: reason instanceof Error ? reason.message : 'WebGPU could not be initialised.',
          hint,
        })
        this.flushStatus()
      } finally {
        this.startPromise = null
      }
    })()

    return this.startPromise
  }

  stop(): void {
    this.stopped = true
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle)
    this.frameHandle = null
    for (const buffers of this.uniformBuffers.values()) for (const buffer of buffers) buffer.destroy()
    this.uniformBuffers.clear()
    for (const texture of this.history.values()) texture.destroy()
    this.history.clear()
    this.nodeTextures.clear()
    this.mediaSubscription?.()
    this.mediaSubscription = null
    this.media?.dispose()
    this.media = null
    this.pool?.dispose()
    this.pool = null
    this.pipelines = null
    for (const surface of this.surfaces.values()) {
      surface.configured = false
    }
    this.publish({ state: 'idle', fps: 0, frameMs: 0, executedNodes: 0 })
    this.flushStatus()
  }

  // -------------------------------------------------------------- surfaces ----

  /**
   * Registers a canvas to be drawn from a node or output. Returns a detach
   * function. Thumbnails pass a lower frame rate; there is no value in
   * redrawing thirty 96-pixel previews sixty times a second.
   */
  attachSurface(
    canvas: HTMLCanvasElement,
    target: SurfaceTarget,
    options: { fps?: number } = {},
  ): () => void {
    const id = ++surfaceCounter
    const context = canvas.getContext('webgpu')
    if (!context) {
      console.warn('[engine] a canvas could not provide a WebGPU context')
      return () => undefined
    }

    const surface: Surface = {
      id,
      canvas,
      context,
      target,
      minIntervalMs: options.fps ? 1000 / options.fps : 0,
      lastDrawn: 0,
      configured: false,
    }
    this.surfaces.set(id, surface)
    return () => {
      this.surfaces.delete(id)
      try {
        context.unconfigure()
      } catch {
        // Unconfiguring a context whose canvas is already gone is harmless.
      }
    }
  }

  setPointer(x: number, y: number, down: boolean): void {
    this.signals.pointer.x = Math.min(1, Math.max(0, x))
    this.signals.pointer.y = Math.min(1, Math.max(0, y))
    this.signals.pointer.down = down ? 1 : 0
  }

  signalValue(nodeId: string): number {
    return this.signals.value(nodeId)
  }

  signalSnapshot(): Map<string, number> {
    return this.signals.snapshot
  }

  mediaEntries() {
    return this.media?.entries() ?? []
  }

  mediaEntry(nodeId: string) {
    return this.media?.get(nodeId)
  }

  async requestScreenCapture(nodeId: string): Promise<void> {
    await this.media?.requestScreenCapture(nodeId)
  }

  /** True when the node produced a texture on the last frame. */
  hasTexture(nodeId: string): boolean {
    return this.nodeTextures.has(nodeId)
  }

  // ------------------------------------------------------------------ loop ----

  private loop = (now: number): void => {
    if (this.stopped) return
    this.frameHandle = requestAnimationFrame(this.loop)

    const store = usePatchStore.getState()
    const interval = 1000 / Math.max(1, store.targetFps)
    if (this.lastTime && now - this.lastTime < interval - 1) return

    const delta = this.lastTime ? Math.min(0.25, (now - this.lastTime) / 1000) : 1 / 60
    this.lastTime = now

    const started = performance.now()
    try {
      this.renderFrame(delta, store)
    } catch (reason) {
      console.error('[engine] frame failed:', reason)
      this.publish({
        state: 'error',
        error: reason instanceof Error ? reason.message : 'A frame failed to render.',
        hint: 'The rest of the app keeps running. Check the console for the failing operator.',
      })
    }

    const elapsed = performance.now() - started
    this.fpsAccumulator += delta
    this.fpsFrames += 1
    if (this.fpsAccumulator >= 0.5) {
      this.publish({
        fps: Math.round(this.fpsFrames / this.fpsAccumulator),
        frameMs: Math.round(elapsed * 100) / 100,
        textures: this.pool?.stats ?? this.status.textures,
        pipelines: this.pipelines?.size ?? 0,
      })
      this.fpsAccumulator = 0
      this.fpsFrames = 0
    }

    this.flushStatus()
  }

  private renderFrame(delta: number, store: ReturnType<typeof usePatchStore.getState>): void {
    const gpu = this.gpu
    const pool = this.pool
    const pipelines = this.pipelines
    const media = this.media
    if (!gpu || !pool || !pipelines || !media) return

    if (store.playing) {
      this.timeline += delta
      this.frameCount += 1
    }

    const nodesById = new Map(store.nodes.map((node) => [node.id, node]))

    // --- plan ---------------------------------------------------------------
    const plan = this.ensurePlan(store.nodes, store.edges)
    this.signals.prune(new Set(nodesById.keys()))

    // --- signals ------------------------------------------------------------
    this.signals.evaluate(plan, nodesById, delta, store.playing)

    // --- external media -----------------------------------------------------
    const remoteStreams = mediaHub.streams
    media.sync(
      store.nodes
        .filter((node) => {
          const spec = getOperator(node.data.op)
          return spec?.runtime === 'external' || spec?.runtime === 'raster'
        })
        .map((node) => {
          const params = resolveParams(node)
          const slot = typeof params.slot === 'string' ? params.slot : ''
          return {
            nodeId: node.id,
            op: node.data.op,
            params,
            remoteStream:
              node.data.op === 'remote-in' ? (remoteStreams.get(slot)?.stream ?? null) : null,
          }
        }),
    )
    media.upload()

    // --- what do we need? ---------------------------------------------------
    const resolution = store.resolution
    if (
      resolution.width !== this.status.resolution.width ||
      resolution.height !== this.status.resolution.height
    ) {
      this.dropHistory()
      pool.trim(resolution.width, resolution.height)
      this.publish({ resolution: { ...resolution } })
    }

    const roots = new Set<string>()
    const outputSources = new Map<string, string | null>()
    for (const outputId of plan.outputs) {
      const source = plan.nodes.get(outputId)?.inputs[0] ?? null
      outputSources.set(outputId, source)
      if (source) roots.add(source)
    }
    for (const surface of this.surfaces.values()) {
      if (surface.target.kind === 'node') roots.add(surface.target.nodeId)
      else {
        const source = outputSources.get(surface.target.nodeId)
        if (source) roots.add(source)
      }
    }
    for (const feedbackId of plan.feedbacks) roots.add(feedbackId)

    const needed = ancestorsOf(plan, roots)

    // --- reference counting -------------------------------------------------
    const remaining = new Map<string, number>()
    const bump = (id: string) => remaining.set(id, (remaining.get(id) ?? 0) + 1)
    for (const id of plan.order) {
      if (!needed.has(id)) continue
      for (const dependency of plan.dependencies.get(id) ?? []) {
        if (needed.has(dependency)) bump(dependency)
      }
    }
    // Roots are consumed after the graph walk, by surfaces and feedback copies.
    for (const root of roots) if (needed.has(root)) bump(root)

    // --- execute ------------------------------------------------------------
    const encoder = gpu.device.createCommandEncoder({ label: 'frame' })
    const textures = new Map<string, GPUTexture>()
    const placeholder = pool.placeholder()
    const sampler = pool.sampler()
    let executed = 0

    for (const id of plan.order) {
      if (!needed.has(id)) continue
      const planNode = plan.nodes.get(id)
      const node = nodesById.get(id)
      if (!planNode || !node || planNode.disabled || planNode.bypassed) continue

      const compiled = this.compiledFor(planNode.spec, node, RENDER_FORMAT)
      if (!compiled) continue

      const inputTextures: GPUTexture[] = []
      if (planNode.spec.runtime === 'external' || planNode.spec.runtime === 'raster') {
        inputTextures.push(media.get(id)?.texture ?? placeholder)
      } else if (planNode.spec.runtime === 'delay') {
        inputTextures.push(this.historyTexture(id, resolution))
      } else {
        for (const input of planNode.inputs) {
          inputTextures.push((input && textures.get(input)) || placeholder)
        }
      }
      while (inputTextures.length < 4) inputTextures.push(placeholder)

      const params = resolveParams(node)
      const buffers = this.uniformsFor(id, compiled.passes.length)

      let previous = placeholder
      const intermediates: GPUTexture[] = []

      for (let index = 0; index < compiled.passes.length; index += 1) {
        const pass = compiled.passes[index]
        const isFinal = index === compiled.passes.length - 1
        // The last pass must land at graph resolution so every node texture is
        // interchangeable; intermediate passes may downsample.
        const scale = isFinal ? 1 : pass.scale
        const width = Math.max(1, Math.round(resolution.width * scale))
        const height = Math.max(1, Math.round(resolution.height * scale))

        const target = pool.acquire(width, height, `${planNode.op}:${index}`)
        if (!isFinal) intermediates.push(target)

        this.writeUniforms(
          buffers[index],
          planNode.spec,
          params,
          planNode.modulations,
          width,
          height,
          index,
          compiled.passes.length,
          id,
        )

        const bindGroup = pipelines.createBindGroup(
          `${planNode.op}:${id}:${index}`,
          buffers[index],
          sampler,
          inputTextures.slice(0, 4),
          previous,
        )

        const renderPass = encoder.beginRenderPass({
          label: `${planNode.op}:${id}:${index}`,
          colorAttachments: [
            {
              view: target.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        renderPass.setPipeline(pass.pipeline)
        renderPass.setBindGroup(0, bindGroup)
        renderPass.draw(3)
        renderPass.end()

        previous = target
        if (isFinal) textures.set(id, target)
      }

      for (const intermediate of intermediates) pool.release(intermediate)
      executed += 1

      // Hand back upstream textures nobody else needs.
      for (const dependency of plan.dependencies.get(id) ?? []) {
        if (!needed.has(dependency)) continue
        const count = (remaining.get(dependency) ?? 1) - 1
        remaining.set(dependency, count)
        if (count <= 0) {
          const texture = textures.get(dependency)
          if (texture) {
            pool.release(texture)
            textures.delete(dependency)
          }
        }
      }
    }

    // --- surfaces -----------------------------------------------------------
    const now = performance.now()
    for (const surface of this.surfaces.values()) {
      if (surface.minIntervalMs && now - surface.lastDrawn < surface.minIntervalMs) continue

      const sourceId =
        surface.target.kind === 'node'
          ? surface.target.nodeId
          : (outputSources.get(surface.target.nodeId) ?? null)
      const sourceTexture = sourceId ? textures.get(sourceId) : undefined

      const outputNode =
        surface.target.kind === 'output' ? nodesById.get(surface.target.nodeId) : undefined
      const spec = outputNode ? getOperator(outputNode.data.op) : getOperator('null')
      if (!spec) continue

      this.drawSurface(
        encoder,
        surface,
        spec,
        outputNode,
        sourceTexture ?? placeholder,
        sampler,
        gpu,
        pipelines,
      )
      surface.lastDrawn = now
    }

    // --- feedback history ---------------------------------------------------
    for (const feedbackId of plan.feedbacks) {
      if (!needed.has(feedbackId)) continue
      const source = plan.delayedDependencies.get(feedbackId)?.[0]
      const sourceTexture = source ? textures.get(source) : undefined
      if (!sourceTexture) continue
      const target = this.historyTexture(feedbackId, resolution)
      if (sourceTexture.width !== target.width || sourceTexture.height !== target.height) continue
      encoder.copyTextureToTexture(
        { texture: sourceTexture },
        { texture: target },
        { width: target.width, height: target.height },
      )
    }

    gpu.device.queue.submit([encoder.finish()])

    // Keep the final textures alive one extra frame so thumbnails attached
    // mid-frame and `hasTexture` queries see something real.
    for (const [id, texture] of this.nodeTextures) {
      if (textures.get(id) !== texture) pool.release(texture)
    }
    this.nodeTextures = textures

    if (executed !== this.status.executedNodes || plan.issues !== this.status.issues) {
      this.publish({ executedNodes: executed, issues: plan.issues })
    }
  }

  private drawSurface(
    encoder: GPUCommandEncoder,
    surface: Surface,
    spec: OperatorSpec,
    node: PatchNode | undefined,
    source: GPUTexture,
    sampler: GPUSampler,
    gpu: GpuContext,
    pipelines: PipelineCache,
  ): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.floor(surface.canvas.clientWidth * ratio))
    const height = Math.max(1, Math.floor(surface.canvas.clientHeight * ratio))
    if (surface.canvas.width !== width || surface.canvas.height !== height) {
      surface.canvas.width = width
      surface.canvas.height = height
      surface.configured = false
    }
    if (!surface.configured) {
      surface.context.configure({
        device: gpu.device,
        format: gpu.canvasFormat,
        alphaMode: 'opaque',
      })
      surface.configured = true
    }

    const compiled = pipelines.get(spec, gpu.canvasFormat)
    const buffers = this.uniformsFor(`surface:${surface.id}:${spec.id}`, 1)
    const params = node ? resolveParams(node) : {}
    const modulations = node ? this.planModulations(node.id) : new Map<string, string>()

    this.writeUniforms(
      buffers[0],
      spec,
      params,
      modulations,
      width,
      height,
      0,
      1,
      node?.id ?? 'surface',
    )

    const bindGroup = pipelines.createBindGroup(
      `surface:${surface.id}`,
      buffers[0],
      sampler,
      [source, source, source, source],
      source,
    )

    const pass = encoder.beginRenderPass({
      label: `surface:${surface.id}`,
      colorAttachments: [
        {
          view: surface.context.getCurrentTexture().createView(),
          clearValue: { r: 0.008, g: 0.012, b: 0.014, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(compiled.passes[compiled.passes.length - 1].pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
  }

  // ---------------------------------------------------------------- helpers ----

  private ensurePlan(nodes: PatchNode[], edges: import('../graph/types').PatchEdge[]): Plan {
    const plan = buildPlan(nodes, edges)
    if (plan.signature !== this.planSignature) {
      this.planSignature = plan.signature
      this.plan = plan
      this.publish({ issues: plan.issues })
      // Feedback state is meaningless once the topology changed underneath it.
      this.dropHistory()
    } else if (this.plan) {
      // Re-use the previous plan object when structure is unchanged, but adopt
      // the fresh resolved inputs so parameter-only edits are picked up.
      this.plan = plan
    }
    return plan
  }

  private planModulations(nodeId: string): Map<string, string> {
    return this.plan?.nodes.get(nodeId)?.modulations ?? new Map()
  }

  private uniformsFor(key: string, count: number): GPUBuffer[] {
    const pipelines = this.pipelines!
    let buffers = this.uniformBuffers.get(key)
    if (!buffers) {
      buffers = []
      this.uniformBuffers.set(key, buffers)
    }
    while (buffers.length < count) buffers.push(pipelines.createUniformBuffer(`${key}:${buffers.length}`))
    return buffers
  }

  private historyTexture(nodeId: string, resolution: Resolution): GPUTexture {
    const existing = this.history.get(nodeId)
    if (existing && existing.width === resolution.width && existing.height === resolution.height) {
      return existing
    }
    existing?.destroy()
    const texture = this.gpu!.device.createTexture({
      label: `feedback:${nodeId}`,
      size: { width: resolution.width, height: resolution.height },
      format: RENDER_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.history.set(nodeId, texture)
    return texture
  }

  private dropHistory(): void {
    for (const texture of this.history.values()) texture.destroy()
    this.history.clear()
  }

  /**
   * Resolves the operator to run for a node, kicking off an async compile for
   * Custom WGSL nodes whose source changed. Until a new compile succeeds the
   * previously working pipeline keeps rendering, so live-coding never blanks
   * the output mid-show.
   */
  private compiledFor(
    spec: OperatorSpec,
    node: PatchNode,
    format: GPUTextureFormat,
  ): CompiledOperator | null {
    const pipelines = this.pipelines
    if (!pipelines) return null
    if (spec.runtime !== 'custom') return pipelines.get(spec, format)

    const source = String(resolveParams(node).source ?? '')
    const known = this.customSources.get(node.id)

    if (known !== source && !this.customPending.has(node.id)) {
      this.customPending.add(node.id)
      void pipelines
        .compileCustom(spec, source, format)
        .then((result) => {
          this.customPending.delete(node.id)
          this.customSources.set(node.id, source)
          const errors = new Map(this.status.shaderErrors)
          if (result.ok) {
            this.customOperators.set(node.id, result.operator)
            errors.delete(node.id)
          } else {
            errors.set(node.id, result.errors)
          }
          this.publish({ shaderErrors: errors })
          this.flushStatus()
        })
        .catch((reason: unknown) => {
          this.customPending.delete(node.id)
          const errors = new Map(this.status.shaderErrors)
          errors.set(node.id, [
            { message: reason instanceof Error ? reason.message : 'Shader compilation failed.' },
          ])
          this.publish({ shaderErrors: errors })
          this.flushStatus()
        })
    }

    return this.customOperators.get(node.id) ?? pipelines.get(spec, format)
  }

  /** Packs the uniform header and all parameter slots for one pass. */
  private writeUniforms(
    buffer: GPUBuffer,
    spec: OperatorSpec,
    params: Record<string, ParamValue>,
    modulations: Map<string, string>,
    width: number,
    height: number,
    passIndex: number,
    passCount: number,
    nodeId: string,
  ): void {
    const data = this.scratch
    data.fill(0)

    data[0] = width
    data[1] = height
    data[2] = this.timeline
    data[3] = this.frameCount
    data[4] = width / Math.max(1, height)
    data[5] = passIndex
    data[6] = passCount
    // Per-node seed keeps two Noise operators from producing identical fields.
    data[7] = hashSeed(nodeId)

    for (const param of spec.params) {
      if (param.slot < 0) continue
      const base = HEADER_FLOATS + param.slot

      if (param.kind === 'color') {
        const value = params[param.key]
        const channels = Array.isArray(value) ? value : [0, 0, 0, 1]
        data[base] = Number(channels[0]) || 0
        data[base + 1] = Number(channels[1]) || 0
        data[base + 2] = Number(channels[2]) || 0
        const alpha = Number(channels[3])
        data[base + 3] = Number.isFinite(alpha) ? alpha : 1
        continue
      }

      // A wired signal wins over the stored value, which is what makes the
      // parameter slider read as "driven" in the inspector.
      const driver = modulations.get(param.key)
      let numeric: number
      if (driver) {
        numeric = this.signals.value(driver)
      } else if (param.system && param.key === 'sourceAspect') {
        numeric = this.media?.aspect(nodeId) ?? 16 / 9
      } else {
        const value = params[param.key]
        numeric = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
      }

      data[base] = Number.isFinite(numeric) ? numeric : 0
    }

    this.gpu!.device.queue.writeBuffer(buffer, 0, data)
  }
}

function hashSeed(value: string): number {
  let h = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index)
    h = Math.imul(h, 16777619)
  }
  // Kept small so sin-based hashes in the prelude stay well-conditioned.
  return ((h >>> 0) % 10000) / 100
}

export const engine = new RenderEngine()
