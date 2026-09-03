/**
 * Shader assembly and pipeline caching.
 *
 * Every texture operator becomes the same shape of program: a fullscreen
 * triangle, one uniform buffer, one sampler, four input textures, and a
 * previous-pass texture. Because that interface never varies, a single explicit
 * bind group layout is shared by the entire catalog and pipelines are pure
 * cache entries keyed by operator, target format, and (for user shaders) source.
 */

import {
  BINDING,
  MAX_TEXTURE_INPUTS,
  UNIFORM_SIZE,
  fragmentEntryWGSL,
  preludeWGSL,
  vertexWGSL,
} from './wgsl/prelude'
import { paramAccessorsWGSL, type OperatorSpec } from './ops/kit'

export type CompiledPass = {
  pipeline: GPURenderPipeline
  /** Render target scale relative to graph resolution. */
  scale: number
  label: string
}

export type CompiledOperator = {
  passes: CompiledPass[]
}

export type CompileResult =
  | { ok: true; operator: CompiledOperator }
  | { ok: false; errors: ShaderError[] }

export type ShaderError = {
  message: string
  /** 1-based line number within the user's own source, when it can be mapped. */
  line?: number
  column?: number
}

/**
 * `glsl` (Custom WGSL) documents its sliders as `k0()`..`k7()` because that is
 * shorter to type in a live-coding context than `p_k0()`. These aliases keep the
 * generated accessors as the single mechanism while honouring that spelling.
 */
const CUSTOM_ALIASES = /* wgsl */ `
fn k0() -> f32 { return p_k0(); }
fn k1() -> f32 { return p_k1(); }
fn k2() -> f32 { return p_k2(); }
fn k3() -> f32 { return p_k3(); }
fn k4() -> f32 { return p_k4(); }
fn k5() -> f32 { return p_k5(); }
fn k6() -> f32 { return p_k6(); }
fn k7() -> f32 { return p_k7(); }
`

export class PipelineCache {
  private readonly cache = new Map<string, CompiledOperator>()
  private readonly modules = new Map<string, GPUShaderModule>()
  readonly bindGroupLayout: GPUBindGroupLayout
  private readonly pipelineLayout: GPUPipelineLayout

  constructor(private readonly device: GPUDevice) {
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'operator-bindings',
      entries: [
        {
          binding: BINDING.uniforms,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: UNIFORM_SIZE },
        },
        {
          binding: BINDING.sampler,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        ...Array.from({ length: MAX_TEXTURE_INPUTS }, (_, index) => ({
          binding: BINDING.input0 + index,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' as const },
        })),
        {
          binding: BINDING.previousPass,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' as const },
        },
      ],
    })

    this.pipelineLayout = device.createPipelineLayout({
      label: 'operator-pipeline-layout',
      bindGroupLayouts: [this.bindGroupLayout],
    })
  }

  /** Full WGSL for one pass of an operator, ready to hand to `createShaderModule`. */
  assemble(spec: OperatorSpec, body: string): string {
    const aliases = spec.runtime === 'custom' ? CUSTOM_ALIASES : ''
    return [
      preludeWGSL,
      paramAccessorsWGSL(spec),
      aliases,
      '// ---- operator body ----',
      body,
      vertexWGSL,
      fragmentEntryWGSL,
    ].join('\n')
  }

  private bodies(spec: OperatorSpec, override?: string): Array<{ shader: string; scale: number; label: string }> {
    if (override !== undefined) {
      const passCount = Math.max(1, Math.min(4, Number(spec.params.find((p) => p.key === 'passes')?.default ?? 1)))
      return Array.from({ length: passCount }, (_, index) => ({
        shader: override,
        scale: 1,
        label: `pass ${index + 1}`,
      }))
    }
    if (spec.passes?.length) {
      return spec.passes.map((pass, index) => ({
        shader: pass.shader,
        scale: pass.scale ?? 1,
        label: pass.label ?? `pass ${index + 1}`,
      }))
    }
    return [{ shader: spec.shader ?? 'fn shade(uv: vec2f) -> vec4f { return t0(uv); }', scale: 1, label: 'main' }]
  }

  /**
   * Compiles (or returns a cached) operator. Synchronous, because catalog
   * shaders are validated at build time by the test suite; user shaders go
   * through `compileCustom` instead so their errors can be reported.
   */
  get(spec: OperatorSpec, targetFormat: GPUTextureFormat, sourceOverride?: string): CompiledOperator {
    const cacheKey = `${spec.id}|${targetFormat}|${sourceOverride ? hash(sourceOverride) : ''}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const passes = this.bodies(spec, sourceOverride).map((pass) => ({
      pipeline: this.createPipeline(spec, pass.shader, targetFormat, pass.label),
      scale: pass.scale,
      label: pass.label,
    }))

    const operator: CompiledOperator = { passes }
    this.cache.set(cacheKey, operator)
    return operator
  }

  /**
   * Compiles user-authored WGSL, reporting compilation diagnostics instead of
   * throwing. Line numbers are shifted back into the user's own coordinate
   * space so the inspector can point at the right line.
   */
  async compileCustom(
    spec: OperatorSpec,
    source: string,
    targetFormat: GPUTextureFormat,
  ): Promise<CompileResult> {
    const cacheKey = `${spec.id}|${targetFormat}|${hash(source)}`
    const cached = this.cache.get(cacheKey)
    if (cached) return { ok: true, operator: cached }

    const assembled = this.assemble(spec, source)
    const preludeLines = assembled.slice(0, assembled.indexOf('// ---- operator body ----')).split('\n').length

    const module = this.device.createShaderModule({ label: `${spec.id}:user`, code: assembled })
    const info = await module.getCompilationInfo()
    const errors = info.messages
      .filter((message) => message.type === 'error')
      .map((message) => ({
        message: message.message,
        line: message.lineNum > 0 ? Math.max(1, message.lineNum - preludeLines) : undefined,
        column: message.linePos || undefined,
      }))

    if (errors.length) return { ok: false, errors }

    // A module can compile and still fail pipeline validation (for example a
    // binding the layout does not declare), so the pipeline is built inside an
    // error scope rather than trusting compilation alone.
    this.device.pushErrorScope('validation')
    const passCount = Math.max(1, Math.min(4, Number(spec.params.find((p) => p.key === 'passes')?.default ?? 1)))
    const passes: CompiledPass[] = []
    for (let index = 0; index < passCount; index += 1) {
      passes.push({
        pipeline: this.device.createRenderPipeline({
          label: `${spec.id}:user:${index}`,
          layout: this.pipelineLayout,
          vertex: { module, entryPoint: 'vsMain' },
          fragment: { module, entryPoint: 'fsMain', targets: [{ format: targetFormat }] },
          primitive: { topology: 'triangle-list' },
        }),
        scale: 1,
        label: `pass ${index + 1}`,
      })
    }
    const validationError = await this.device.popErrorScope()
    if (validationError) return { ok: false, errors: [{ message: validationError.message }] }

    const operator: CompiledOperator = { passes }
    this.cache.set(cacheKey, operator)
    return { ok: true, operator }
  }

  private createPipeline(
    spec: OperatorSpec,
    body: string,
    targetFormat: GPUTextureFormat,
    label: string,
  ): GPURenderPipeline {
    const code = this.assemble(spec, body)
    const moduleKey = hash(code)
    let module = this.modules.get(moduleKey)
    if (!module) {
      module = this.device.createShaderModule({ label: `${spec.id}:${label}`, code })
      this.modules.set(moduleKey, module)
    }

    return this.device.createRenderPipeline({
      label: `${spec.id}:${label}:${targetFormat}`,
      layout: this.pipelineLayout,
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: targetFormat }] },
      primitive: { topology: 'triangle-list' },
    })
  }

  createUniformBuffer(label: string): GPUBuffer {
    return this.device.createBuffer({
      label: `uniforms:${label}`,
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  createBindGroup(
    label: string,
    uniforms: GPUBuffer,
    sampler: GPUSampler,
    inputs: Array<GPUTexture>,
    previous: GPUTexture,
  ): GPUBindGroup {
    return this.device.createBindGroup({
      label: `bind:${label}`,
      layout: this.bindGroupLayout,
      entries: [
        { binding: BINDING.uniforms, resource: { buffer: uniforms } },
        { binding: BINDING.sampler, resource: sampler },
        ...inputs.map((texture, index) => ({
          binding: BINDING.input0 + index,
          resource: texture.createView(),
        })),
        { binding: BINDING.previousPass, resource: previous.createView() },
      ],
    })
  }

  get size(): number {
    return this.cache.size
  }
}

/** Small stable string hash, only used for cache keys. */
function hash(value: string): string {
  let h = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
