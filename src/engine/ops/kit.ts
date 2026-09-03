/**
 * Authoring kit for operators.
 *
 * An operator is a single declarative object. Everything the editor needs —
 * ports, parameters, inspector widgets, uniform packing, WGSL, and WebMCP
 * documentation — is derived from it, so the catalog can never advertise an
 * operator the renderer cannot actually run.
 */

export type OperatorFamily = 'TOP' | 'CHOP'

export type OperatorCategory =
  | 'source'
  | 'generator'
  | 'filter'
  | 'warp'
  | 'composite'
  | 'control'
  | 'audio'
  | 'output'

/** How the renderer realises this operator. */
export type OperatorRuntime =
  /** One or more fullscreen fragment passes generated from `shader`/`passes`. */
  | 'shader'
  /** Uploads an outside image source (camera, video, screen, remote peer). */
  | 'external'
  /** CPU-rasterised into a texture (text). */
  | 'raster'
  /** One-frame delay line; enables feedback loops. */
  | 'delay'
  /** User-authored WGSL compiled at runtime. */
  | 'custom'
  /** Terminal node; publishes a texture to a display surface. */
  | 'output'
  /** Numeric signal evaluated on the CPU each frame. */
  | 'signal'

export type ParamKind =
  | 'float'
  | 'int'
  | 'bool'
  | 'menu'
  | 'color'
  | 'text'
  | 'wgsl'
  | 'device'
  | 'file'

export type ParamSpec = {
  key: string
  label: string
  kind: ParamKind
  default: number | boolean | string | [number, number, number, number]
  min?: number
  max?: number
  step?: number
  /** Menu entries; index is what lands in the uniform buffer. */
  options?: string[]
  /** Grouping hint for the inspector. */
  page?: string
  help?: string
  /** Unit suffix rendered in the inspector. */
  unit?: string
  /** Logarithmic slider response. */
  log?: boolean
  /**
   * Written by the engine every frame rather than by the user (for example the
   * native aspect ratio of a camera). Hidden from the inspector and never
   * modulatable.
   */
  system?: boolean
  /**
   * Assigned by `finalizeOperator`. Index into the 48-float uniform array,
   * or -1 for CPU-side parameters that never reach the GPU.
   */
  slot: number
  /** True when a CHOP wire may drive this parameter. */
  modulatable: boolean
}

export type PortSpec = {
  id: string
  label: string
  type: 'texture' | 'number'
  /**
   * A delayed port is read from the previous frame, so it is excluded from
   * cycle detection and topological ordering. This is what makes feedback
   * loops legal.
   */
  delayed?: boolean
  optional?: boolean
}

export type ShaderPass = {
  /** WGSL body defining `fn shade(uv: vec2f) -> vec4f`. */
  shader: string
  /** Render target scale relative to graph resolution (bloom downsampling). */
  scale?: number
  label?: string
}

/** Per-frame audio analysis handed to CHOP evaluators. */
export type AudioFrame = {
  active: boolean
  /** Smoothed RMS level, roughly 0..1. */
  level: number
  /** Instantaneous peak, roughly 0..1. */
  peak: number
  /** Normalised magnitude per FFT bin, 0..1. */
  spectrum: Float32Array
  sampleRate: number
  fftSize: number
  /** Onset envelope that snaps to 1 on a beat and decays. */
  beat: number
  /** True only on the frame an onset was detected. */
  beatPulse: boolean
  /** Best current tempo estimate, or 0 when unknown. */
  bpm: number
}

/** Everything a numeric signal operator can read when it is evaluated. */
export type ChopContext = {
  /** Seconds since the timeline started, honouring pause. */
  time: number
  /** Seconds since the previous evaluation. */
  delta: number
  frame: number
  /** Values of the upstream CHOPs wired into this node's inputs. */
  inputs: number[]
  /** Resolved parameter values for this node. */
  params: Record<string, number | string | boolean>
  /** Persistent scratch space, keyed per node and preserved across frames. */
  state: Record<string, number>
  audio: AudioFrame
  /** Average normalised magnitude between two frequencies, in Hz. */
  band: (lowHz: number, highHz: number) => number
  pointer: { x: number; y: number; down: number }
  /** Latest value of a MIDI continuous controller, 0..1. */
  midi: (channel: number, controller: number) => number
}

export type ChopEvaluator = (ctx: ChopContext) => number

export type OperatorSpec = {
  id: string
  label: string
  family: OperatorFamily
  category: OperatorCategory
  runtime: OperatorRuntime
  description: string
  /** Extra search keywords, including TouchDesigner equivalents. */
  keywords?: string[]
  /** TouchDesigner operator this is modelled on, shown in the inspector. */
  td?: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  params: ParamSpec[]
  /** Single-pass shader body. Mutually exclusive with `passes`. */
  shader?: string
  /** Multi-pass shader bodies. `prev(uv)` reads the previous pass. */
  passes?: ShaderPass[]
  /** Number of uniform float slots consumed. */
  slotCount: number
  /** CPU evaluation for `signal` operators. */
  evaluate?: ChopEvaluator
}

/** Declarative input before slots are assigned. */
export type OperatorInput = Omit<
  OperatorSpec,
  'inputs' | 'outputs' | 'params' | 'slotCount' | 'family'
> & {
  family?: OperatorFamily
  /** Texture input labels, or full port specs for delayed/optional ports. */
  inputs?: (string | PortSpec)[]
  outputs?: PortSpec[]
  params?: ParamDraft[]
}

export type ParamDraft = Omit<ParamSpec, 'slot' | 'modulatable'> & {
  modulatable?: boolean
}

// ------------------------------------------------------------- param DSL ----

/** Continuous float parameter. A CHOP can drive it. */
export const F = (
  key: string,
  label: string,
  def: number,
  min = 0,
  max = 1,
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({
  key,
  label,
  kind: 'float',
  default: def,
  min,
  max,
  step: (max - min) / 1000,
  ...extra,
})

/** Integer parameter (segment counts, octaves, iteration counts). */
export const INT = (
  key: string,
  label: string,
  def: number,
  min: number,
  max: number,
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({
  key,
  label,
  kind: 'int',
  default: def,
  min,
  max,
  step: 1,
  ...extra,
})

export const BOOL = (
  key: string,
  label: string,
  def: boolean,
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({ key, label, kind: 'bool', default: def, ...extra })

/** Menu parameter. The selected index reaches the shader as an f32. */
export const MENU = (
  key: string,
  label: string,
  def: number,
  options: string[],
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({
  key,
  label,
  kind: 'menu',
  default: def,
  options,
  min: 0,
  max: options.length - 1,
  step: 1,
  ...extra,
})

/** RGBA colour. Consumes four uniform slots and is exposed as a vec4f. */
export const COLOR = (
  key: string,
  label: string,
  def: [number, number, number, number],
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({ key, label, kind: 'color', default: def, ...extra })

/** CPU-side string (text content, device labels, URLs, WGSL source). */
export const TEXT = (
  key: string,
  label: string,
  def: string,
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({ key, label, kind: 'text', default: def, ...extra })

export const WGSL = (key: string, label: string, def: string): ParamDraft => ({
  key,
  label,
  kind: 'wgsl',
  default: def,
})

export const DEVICE = (key: string, label: string): ParamDraft => ({
  key,
  label,
  kind: 'device',
  default: '',
})

export const FILE = (
  key: string,
  label: string,
  extra: Partial<ParamDraft> = {},
): ParamDraft => ({ key, label, kind: 'file', default: '', ...extra })

// ------------------------------------------------------------- assembling ----

const SLOTS_PER_KIND: Record<ParamKind, number> = {
  float: 1,
  int: 1,
  bool: 1,
  menu: 1,
  color: 4,
  text: 0,
  wgsl: 0,
  device: 0,
  file: 0,
}

const MODULATABLE_KINDS: ParamKind[] = ['float', 'int', 'bool', 'menu']

const textureOut = (): PortSpec[] => [{ id: 'out', label: 'Texture', type: 'texture' }]
const numberOut = (): PortSpec[] => [{ id: 'out', label: 'Value', type: 'number' }]

/**
 * Assigns uniform slots, normalises ports, and validates the declaration.
 * Throws at module load if an operator over-subscribes its uniform budget or
 * declares duplicate parameter keys — failures show up immediately at startup
 * rather than as silent visual glitches.
 */
export function finalizeOperator(input: OperatorInput): OperatorSpec {
  const family: OperatorFamily = input.family ?? (input.runtime === 'signal' ? 'CHOP' : 'TOP')
  const portType = family === 'CHOP' ? 'number' : 'texture'

  const inputs: PortSpec[] = (input.inputs ?? []).map((port, index) =>
    typeof port === 'string'
      ? { id: `in-${index}`, label: port, type: portType }
      : { ...port, id: port.id || `in-${index}` },
  )

  const outputs =
    input.outputs ??
    (input.runtime === 'output' ? [] : family === 'CHOP' ? numberOut() : textureOut())

  let slot = 0
  const seen = new Set<string>()
  const params: ParamSpec[] = (input.params ?? []).map((draft) => {
    if (seen.has(draft.key)) {
      throw new Error(`Operator "${input.id}" declares parameter "${draft.key}" twice.`)
    }
    seen.add(draft.key)

    const width = SLOTS_PER_KIND[draft.kind]
    const assigned = width > 0 ? slot : -1
    slot += width

    return {
      ...draft,
      slot: assigned,
      modulatable:
        !draft.system && (draft.modulatable ?? MODULATABLE_KINDS.includes(draft.kind)),
    }
  })

  if (slot > 48) {
    throw new Error(
      `Operator "${input.id}" needs ${slot} uniform slots but only 48 are available.`,
    )
  }
  if (inputs.length > 4) {
    throw new Error(`Operator "${input.id}" declares ${inputs.length} inputs; the limit is 4.`)
  }
  if (input.shader && input.passes) {
    throw new Error(`Operator "${input.id}" declares both "shader" and "passes".`)
  }

  return {
    ...input,
    family,
    inputs,
    outputs,
    params,
    slotCount: slot,
  }
}

/** Convenience wrapper for a texture operator. */
export const top = (input: Omit<OperatorInput, 'family'>): OperatorSpec =>
  finalizeOperator({ ...input, family: 'TOP' })

/** Convenience wrapper for a numeric signal operator. */
export const chop = (input: Omit<OperatorInput, 'family' | 'runtime'>): OperatorSpec =>
  finalizeOperator({ ...input, family: 'CHOP', runtime: 'signal' })

// --------------------------------------------------------------- codegen ----

const upperFirst = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

/**
 * Emits `p_<key>()` accessors for an operator's parameters so shader bodies
 * read parameters by name instead of by hand-counted uniform index.
 */
export function paramAccessorsWGSL(spec: OperatorSpec): string {
  const lines: string[] = []
  for (const param of spec.params) {
    if (param.slot < 0) continue
    const name = `p_${param.key}`
    if (param.kind === 'color') {
      const c = (offset: number) => component(param.slot + offset)
      lines.push(
        `fn ${name}() -> vec4f { return vec4f(${c(0)}, ${c(1)}, ${c(2)}, ${c(3)}); }`,
      )
    } else if (param.kind === 'int' || param.kind === 'menu') {
      lines.push(`fn ${name}() -> f32 { return ${component(param.slot)}; }`)
      lines.push(`fn ${name}I() -> i32 { return i32(${component(param.slot)} + 0.5); }`)
    } else if (param.kind === 'bool') {
      lines.push(`fn ${name}() -> f32 { return ${component(param.slot)}; }`)
      lines.push(`fn ${name}B() -> bool { return ${component(param.slot)} > 0.5; }`)
    } else {
      lines.push(`fn ${name}() -> f32 { return ${component(param.slot)}; }`)
    }
  }
  return lines.join('\n')
}

const component = (slot: number) => {
  const vec = Math.floor(slot / 4)
  const lane = ['x', 'y', 'z', 'w'][slot % 4]
  return `U.p[${vec}].${lane}`
}

/** Human-readable parameter reference, used by the inspector and WebMCP docs. */
export function describeParam(param: ParamSpec): string {
  if (param.kind === 'menu') {
    const options = (param.options ?? []).map((option, index) => `${index}=${option}`).join(', ')
    return `${param.key} (menu, ${options})`
  }
  if (param.kind === 'bool') {
    return `${param.key} (bool, false|true)`
  }
  if (param.kind === 'color') {
    return `${param.key} (color, rgba [0..1, 0..1, 0..1, 0..1])`
  }
  if (param.kind === 'text' || param.kind === 'wgsl' || param.kind === 'file' || param.kind === 'device') {
    return `${param.key} (${param.kind})`
  }
  return `${param.key} (${param.kind}, ${param.min ?? 0}..${param.max ?? 1})`
}

export { upperFirst }
