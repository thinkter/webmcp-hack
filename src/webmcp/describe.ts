/**
 * Shared plumbing for the WebMCP tool surface: argument reading, lenient name
 * resolution, and text formatting.
 *
 * Everything an agent ever reads about this application is a string produced
 * here, so the formatting rules live in one place:
 *
 *  - stable field order, short labelled lines, no JSON dumps of live objects
 *  - node references always render as `name [id]` so the agent can copy either
 *  - long lists are capped and say which argument narrows them
 *  - failures throw `ToolError` with the operator/node name, what was wrong,
 *    and what to do instead; `register.ts` turns those into MCP error results
 */

import { ancestorsOf, buildPlan, type Plan } from '../engine/compile'
import { describeParam, getOperator, operatorMap, searchOperators } from '../engine/ops'
import type { OperatorSpec, ParamSpec, PortSpec } from '../engine/ops/kit'
import { engine } from '../engine/renderer'
import { formatParam, resolveParams, usePatchStore, type PatchState } from '../graph/store'
import {
  isParamHandle,
  paramKeyFromHandle,
  type ParamValue,
  type PatchEdge,
  type PatchNode,
} from '../graph/types'

// --------------------------------------------------------------- failures ----

/** A failure the agent can act on. Never used for programming errors. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

export function fail(message: string): never {
  throw new ToolError(message)
}

// -------------------------------------------------------------- arguments ----

type Args = Record<string, unknown>

const trimmed = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim().length) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

export const optString = (args: Args, key: string): string | undefined => trimmed(args[key])

export function reqString(args: Args, key: string, hint: string): string {
  const value = trimmed(args[key])
  if (value === undefined) fail(`Missing required argument "${key}". ${hint}`)
  return value
}

export function optNumber(args: Args, key: string): number | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    fail(`Argument "${key}" must be a number; received ${JSON.stringify(raw)}.`)
  }
  return parsed
}

export function optBool(args: Args, key: string): boolean | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'boolean') return raw
  if (raw === 'true' || raw === 1) return true
  if (raw === 'false' || raw === 0) return false
  fail(`Argument "${key}" must be true or false; received ${JSON.stringify(raw)}.`)
}

/** Accepts an array of strings, or a comma-separated string. */
export function optStringList(args: Args, key: string): string[] | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  if (Array.isArray(raw)) {
    return raw.map((entry) => trimmed(entry)).filter((entry): entry is string => !!entry)
  }
  const single = trimmed(raw)
  if (single === undefined) return undefined
  return single
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function optRecord(args: Args, key: string): Args | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Args
    } catch {
      fail(`Argument "${key}" is a string that is not valid JSON. Pass an object instead.`)
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`Argument "${key}" must be an object of key/value pairs.`)
  }
  return raw as Args
}

// ------------------------------------------------------------------ output ----

/** Responses stay small enough that an agent can read several in one turn. */
export const MAX_RESPONSE = 5600

export function clip(text: string, limit = MAX_RESPONSE): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const boundary = cut.lastIndexOf('\n')
  const body = boundary > limit * 0.5 ? cut.slice(0, boundary) : cut
  return `${body}\n… response truncated. Narrow it with a nodeId, query, category, or limit argument.`
}

/** Caps a list and says how to see the rest. */
export function capLines(lines: string[], limit: number, hint: string): string[] {
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit), `  … and ${lines.length - limit} more. ${hint}`]
}

export function section(title: string, lines: string[], empty?: string): string[] {
  if (!lines.length) return empty ? [title, `  ${empty}`] : []
  return [title, ...lines]
}

export const joinLines = (lines: Array<string | null | undefined>): string =>
  clip(lines.filter((line): line is string => line !== null && line !== undefined).join('\n'))

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m ago`
}

export const shorten = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`

export const num = (value: number, digits = 3): string => {
  if (!Number.isFinite(value)) return '?'
  const fixed = value.toFixed(digits)
  return fixed.replace(/\.?0+$/, '') || '0'
}

// ------------------------------------------------------------ graph context ----

export type GraphContext = {
  state: PatchState
  nodes: PatchNode[]
  edges: PatchEdge[]
  plan: Plan
  /** Texture nodes whose pixels some output actually needs this frame. */
  needed: Set<string>
  engineRunning: boolean
}

/**
 * One snapshot per tool call. The plan is rebuilt rather than read off the
 * engine so that read-back is correct even when the GPU never started (a
 * headless test, a machine without WebGPU) and immediately after a mutation.
 */
export function graphContext(): GraphContext {
  const state = usePatchStore.getState()
  const plan = buildPlan(state.nodes, state.edges)
  return {
    state,
    nodes: state.nodes,
    edges: state.edges,
    plan,
    needed: ancestorsOf(plan, plan.outputs),
    engineRunning: engine.getStatus().state === 'running',
  }
}

export const nodeById = (ctx: GraphContext, id: string): PatchNode | undefined =>
  ctx.nodes.find((node) => node.id === id)

/** Operator spec for a node, or a hard failure: an unknown op is unusable. */
export function specOf(node: PatchNode): OperatorSpec {
  const spec = getOperator(node.data.op)
  if (!spec) {
    fail(
      `${nodeRef(node)} refers to operator "${node.data.op}", which this build does not know about. ` +
        'Delete the node, or call list_operators for what is available.',
    )
  }
  return spec
}

export const edgesInto = (ctx: GraphContext, id: string): PatchEdge[] =>
  ctx.edges.filter((edge) => edge.target === id)

export const edgesOutOf = (ctx: GraphContext, id: string): PatchEdge[] =>
  ctx.edges.filter((edge) => edge.source === id)

/** Parameter key → the signal node driving it. */
export function paramDrivers(ctx: GraphContext, id: string): Map<string, PatchNode> {
  const drivers = new Map<string, PatchNode>()
  for (const edge of edgesInto(ctx, id)) {
    if (!isParamHandle(edge.targetHandle)) continue
    const source = nodeById(ctx, edge.source)
    if (source) drivers.set(paramKeyFromHandle(edge.targetHandle!), source)
  }
  return drivers
}

export function driverEdge(
  ctx: GraphContext,
  id: string,
  key: string,
): PatchEdge | undefined {
  return ctx.edges.find(
    (edge) =>
      edge.target === id && isParamHandle(edge.targetHandle) && paramKeyFromHandle(edge.targetHandle!) === key,
  )
}

export const isFreeInput = (ctx: GraphContext, id: string, portId: string): boolean =>
  !ctx.edges.some((edge) => edge.target === id && edge.targetHandle === portId)

// ------------------------------------------------------------- resolution ----

export const nodeRef = (node: PatchNode): string => `"${node.data.name}" [${node.id}]`

/**
 * Lenient node lookup, in tiers: exact id, exact name, operator label, operator
 * id, name prefix, name substring. The first tier with any hit wins, so
 * "glitch", "Glitch", and "glitch-1" all land on the same node.
 */
export function matchNodes(ref: string, ctx: GraphContext): PatchNode[] {
  const needle = ref.trim().toLowerCase()
  if (!needle) return []
  const label = (node: PatchNode) => (getOperator(node.data.op)?.label ?? '').toLowerCase()
  const name = (node: PatchNode) => node.data.name.toLowerCase()
  const tiers = [
    ctx.nodes.filter((node) => node.id.toLowerCase() === needle),
    ctx.nodes.filter((node) => name(node) === needle),
    ctx.nodes.filter((node) => label(node) === needle),
    ctx.nodes.filter((node) => node.data.op.toLowerCase() === needle),
    ctx.nodes.filter((node) => name(node).startsWith(needle)),
    ctx.nodes.filter((node) => name(node).includes(needle) || label(node).includes(needle)),
  ]
  return tiers.find((tier) => tier.length > 0) ?? []
}

/** The `resolveNode` every tool uses. Accepts an id, a name, or an operator label. */
export function resolveNode(ref: string, ctx: GraphContext): PatchNode {
  const matches = matchNodes(ref, ctx)
  if (matches.length === 1) return matches[0]

  if (matches.length > 1) {
    fail(
      `"${ref}" matches ${matches.length} nodes: ${matches
        .slice(0, 6)
        .map((node) => nodeRef(node))
        .join(', ')}. Pass the node id instead.`,
    )
  }

  const known = capLines(
    ctx.nodes.map((node) => `${node.data.name} [${node.id}]`),
    12,
    'call inspect_graph for the full list.',
  ).join(', ')
  fail(
    `No node matches "${ref}". Nodes in this patch: ${known}. ` +
      'Reference a node by its id or its name; call inspect_graph to see both.',
  )
}

export function resolveNodes(refs: string[], ctx: GraphContext): PatchNode[] {
  const seen = new Set<string>()
  const out: PatchNode[] = []
  for (const ref of refs) {
    const node = resolveNode(ref, ctx)
    if (seen.has(node.id)) continue
    seen.add(node.id)
    out.push(node)
  }
  return out
}

/** Operator lookup by id or label, with `searchOperators` suggestions on miss. */
export function resolveOperator(ref: string): OperatorSpec {
  const needle = ref.trim().toLowerCase()
  const direct = operatorMap.get(needle)
  if (direct) return direct

  const byLabel = [...operatorMap.values()].find(
    (spec) => spec.label.toLowerCase() === needle || spec.id.toLowerCase() === needle,
  )
  if (byLabel) return byLabel

  const suggestions = searchOperators(ref)
    .slice(0, 6)
    .map((spec) => `${spec.id} (${spec.label})`)
  fail(
    `"${ref}" is not an operator id.` +
      (suggestions.length
        ? ` Closest matches: ${suggestions.join(', ')}.`
        : ' No operator matched that text.') +
      ' Call list_operators to browse the catalog by category.',
  )
}

/** Parameter lookup by key or label, case- and space-insensitive. */
export function resolveParamSpec(spec: OperatorSpec, ref: string): ParamSpec {
  const needle = ref.trim().toLowerCase()
  const flat = needle.replace(/[\s_-]/g, '')
  const found = spec.params.find(
    (param) =>
      param.key.toLowerCase() === needle ||
      param.label.toLowerCase() === needle ||
      param.key.toLowerCase().replace(/[\s_-]/g, '') === flat ||
      param.label.toLowerCase().replace(/[\s_-]/g, '') === flat,
  )
  if (found) return found

  const keys = capLines(
    spec.params.filter((param) => !param.system).map((param) => param.key),
    18,
    `call describe_operator with operator="${spec.id}".`,
  ).join(', ')
  fail(
    `${spec.label} has no parameter "${ref}". Its parameters are: ${keys}. ` +
      'Parameter names are accepted as keys ("amount") or labels ("Amount").',
  )
}

/** Input port lookup by port id, port label, or numeric index. */
export function resolveInputPort(spec: OperatorSpec, ref: string): PortSpec {
  const needle = ref.trim().toLowerCase()
  const byIndex = /^\d+$/.test(needle) ? spec.inputs[Number(needle)] : undefined
  const found =
    byIndex ??
    spec.inputs.find(
      (port) => port.id.toLowerCase() === needle || port.label.toLowerCase() === needle,
    )
  if (found) return found

  if (!spec.inputs.length) {
    fail(
      `${spec.label} has no inputs at all — it is a ${spec.category} operator that generates its own signal. ` +
        'Nothing can be connected into it.',
    )
  }
  fail(
    `${spec.label} has no input "${ref}". Its inputs are: ${spec.inputs
      .map((port, index) => `${port.id} ("${port.label}", ${port.type}, index ${index})`)
      .join(', ')}. To drive a parameter instead, pass toParameter.`,
  )
}

// ------------------------------------------------------------- formatting ----

export const familyTag = (spec: OperatorSpec): string =>
  spec.family === 'CHOP' ? 'signal' : 'texture'

/** Live state of one node, in the same words the monitor would use. */
export function liveState(ctx: GraphContext, node: PatchNode): string {
  const spec = getOperator(node.data.op)
  if (!node.data.enabled) return 'DISABLED (outputs nothing)'
  if (spec?.family === 'CHOP') return `signal ${num(engine.signalValue(node.id))}`
  if (node.data.bypass) return 'BYPASSED (passes input 1 through)'
  if (!ctx.engineRunning) return 'engine not running'
  if (engine.hasTexture(node.id)) return 'executing'
  if (spec?.runtime === 'output') return ctx.needed.has(node.id) ? 'output active' : 'output idle'
  return ctx.needed.has(node.id) ? 'needed but produced no texture' : 'idle (no output needs it)'
}

/** `key=value` for parameters the user has actually changed. */
export function changedParams(node: PatchNode, spec: OperatorSpec): string[] {
  return spec.params
    .filter((param) => node.data.params[param.key] !== undefined && !param.system)
    .map((param) => `${param.key}=${formatParam(param, node.data.params[param.key])}`)
}

/** One line per node, for whole-graph listings. */
export function nodeLine(ctx: GraphContext, node: PatchNode): string {
  const spec = getOperator(node.data.op)
  const head = `${node.id}  ${node.data.op}  "${node.data.name}"`
  if (!spec) return `${head}  [UNKNOWN OPERATOR — this build cannot run it]`

  const marks: string[] = []
  if (!node.data.enabled) marks.push('disabled')
  if (node.data.bypass) marks.push('bypass')

  const inputs = spec.inputs
    .map((port) => {
      const edge = ctx.edges.find(
        (candidate) => candidate.target === node.id && candidate.targetHandle === port.id,
      )
      const source = edge ? nodeById(ctx, edge.source) : undefined
      if (!source) return null
      return `${port.id}${port.delayed ? '⟲' : '←'}${source.data.name}`
    })
    .filter((entry): entry is string => entry !== null)

  const missing = spec.inputs.filter(
    (port) => !port.optional && isFreeInput(ctx, node.id, port.id),
  )
  const drivers = [...paramDrivers(ctx, node.id)].map(
    ([key, source]) => `${key}←${source.data.name}`,
  )
  const params = changedParams(node, spec)

  const fields = [
    head,
    `[${liveState(ctx, node)}${marks.length ? `, ${marks.join(', ')}` : ''}]`,
    inputs.length ? `in: ${inputs.join(' ')}` : null,
    missing.length ? `unwired: ${missing.map((port) => port.id).join(',')}` : null,
    drivers.length ? `mod: ${drivers.join(' ')}` : null,
    params.length ? `set: ${shorten(params.join(' '), 110)}` : null,
  ]
  return fields.filter((field): field is string => field !== null).join('  ')
}

/** Full parameter table for one node, including what is driving each value. */
export function paramTable(ctx: GraphContext, node: PatchNode, spec: OperatorSpec): string[] {
  const values = resolveParams(node)
  const drivers = paramDrivers(ctx, node.id)

  return spec.params.map((param) => {
    const value = values[param.key] as ParamValue
    const driver = drivers.get(param.key)
    const overridden = node.data.params[param.key] !== undefined
    // `describeParam` prints a numeric range for every kind, which is misleading
    // for text and colour, so it is only used where a range means something.
    const numeric = param.kind === 'float' || param.kind === 'int' || param.kind === 'menu' || param.kind === 'bool'
    const notes: string[] = [numeric ? describeParam(param) : `${param.key} (${param.kind})`]
    if (param.unit) notes.push(param.unit)
    if (param.system) notes.push('engine-written')
    else if (!param.modulatable) notes.push('not modulatable')
    if (param.page) notes.push(`page ${param.page}`)

    const driven = driver
      ? `  DRIVEN BY ${driver.data.name} [${driver.id}] = ${num(engine.signalValue(driver.id))}`
      : ''
    const dirty = overridden ? '*' : ' '
    return (
      `  ${dirty}${param.label.padEnd(16)} = ${shorten(formatParam(param, value), 26).padEnd(26)}` +
      ` default ${shorten(formatParam(param, param.default), 18).padEnd(18)} ${notes.join(', ')}${driven}`
    )
  })
}

// ------------------------------------------------------- operator catalog ----

export function operatorBrief(spec: OperatorSpec): string {
  // Deliberately tight: the whole 70-operator catalog has to fit in one response.
  return `  ${spec.id.padEnd(16)} ${spec.label.padEnd(15)} ${shorten(spec.description, 35)}`
}

export function operatorRich(spec: OperatorSpec): string[] {
  const modulatable = spec.params.filter((param) => param.modulatable).map((param) => param.key)
  return [
    `  ${spec.id.padEnd(16)} ${spec.label}${spec.td ? `  ·  TD: ${spec.td}` : ''}`,
    `      ${shorten(spec.description, 130)}`,
    `      family ${spec.family} · runtime ${spec.runtime} · inputs: ${
      spec.inputs.length
        ? spec.inputs
            .map((port) => `${port.label}(${port.type}${port.delayed ? ', delayed' : ''}${port.optional ? ', optional' : ''})`)
            .join(', ')
        : 'none'
    }`,
    `      modulatable: ${modulatable.length ? shorten(modulatable.join(', '), 150) : 'none'}`,
  ]
}

export function operatorFull(spec: OperatorSpec): string {
  const lines: string[] = [
    `OPERATOR ${spec.id}  "${spec.label}"`,
    `family ${spec.family} (${familyTag(spec)}) · category ${spec.category} · runtime ${spec.runtime}`,
    spec.td ? `TouchDesigner equivalent: ${spec.td}` : null,
    spec.description,
    spec.keywords?.length ? `keywords: ${spec.keywords.join(', ')}` : null,
    '',
    `INPUTS (${spec.inputs.length})`,
    ...(spec.inputs.length
      ? spec.inputs.map(
          (port, index) =>
            `  ${port.id} (index ${index})  "${port.label}"  ${port.type}` +
            `${port.delayed ? '  DELAYED — read from the previous frame, legal in a feedback loop' : ''}` +
            `${port.optional ? '  optional' : ''}`,
        )
      : ['  none — this operator generates its own signal']),
    '',
    `OUTPUTS (${spec.outputs.length})`,
    ...(spec.outputs.length
      ? spec.outputs.map((port) => `  ${port.id}  "${port.label}"  ${port.type}`)
      : ['  none — this is a terminal output operator']),
    '',
    `PARAMETERS (${spec.params.length})`,
  ].filter((line): line is string => line !== null)

  for (const param of spec.params) {
    lines.push(
      `  ${param.key.padEnd(16)} "${param.label}"  ${param.kind}` +
        `  default ${formatParam(param, param.default)}` +
        (param.kind === 'float' || param.kind === 'int'
          ? `  range ${param.min ?? '-'}..${param.max ?? '-'}${param.unit ? ` ${param.unit}` : ''}${param.log ? ' (log)' : ''}`
          : '') +
        (param.options?.length
          ? `  options ${param.options.map((option, index) => `${index}=${option}`).join(', ')}`
          : '') +
        (param.page ? `  page ${param.page}` : '') +
        (param.system
          ? '  ENGINE-WRITTEN (do not set)'
          : param.modulatable
            ? '  modulatable (a signal operator can drive it)'
            : '  not modulatable'),
    )
    if (param.help) lines.push(`      ${param.help}`)
  }

  return joinLines(lines)
}


// ------------------------------------------------------------- traversal ----

export type Hop = {
  node: PatchNode
  depth: number
  /** How this node reached the node it was found from. */
  via: string
}

/**
 * Breadth-first walk of the wiring, nearest first. Signal (parameter) links and
 * delayed feedback links are labelled rather than skipped, because "what affects
 * this" is exactly the question `trace_dependencies` answers.
 */
export function walk(
  ctx: GraphContext,
  startId: string,
  direction: 'upstream' | 'downstream',
): Hop[] {
  const seen = new Set<string>([startId])
  const out: Hop[] = []
  let frontier: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }]

  while (frontier.length && out.length < 60) {
    const next: Array<{ id: string; depth: number }> = []
    for (const current of frontier) {
      const edges =
        direction === 'upstream' ? edgesInto(ctx, current.id) : edgesOutOf(ctx, current.id)
      for (const edge of edges) {
        const otherId = direction === 'upstream' ? edge.source : edge.target
        if (seen.has(otherId)) continue
        const other = nodeById(ctx, otherId)
        const anchor = nodeById(ctx, current.id)
        if (!other || !anchor) continue
        seen.add(otherId)
        out.push({ node: other, depth: current.depth + 1, via: edgeLabel(edge, anchor, other, direction) })
        next.push({ id: otherId, depth: current.depth + 1 })
      }
    }
    frontier = next
  }
  return out
}

function edgeLabel(
  edge: PatchEdge,
  anchor: PatchNode,
  other: PatchNode,
  direction: 'upstream' | 'downstream',
): string {
  const handle = edge.targetHandle ?? ''
  const parameter = isParamHandle(handle) ? paramKeyFromHandle(handle) : null
  const targetNode = direction === 'upstream' ? anchor : other
  const targetSpec = getOperator(targetNode.data.op)
  const delayed = targetSpec?.inputs.some((port) => port.id === handle && port.delayed) ?? false
  // 'number' and a parameter link are both signal flow as far as the agent is
  // concerned; only texture versus signal matters.
  const kind = parameter || edge.data?.kind === 'number' ? 'signal' : 'texture'
  const where = parameter ? `${targetNode.data.name}.${parameter}` : `${targetNode.data.name}.${handle || 'in'}`
  return `${kind}${delayed ? ' DELAYED(feedback)' : ''} → ${where}`
}

/** Left-to-right chain from the deepest source to `id`, for output topology. */
export function textureChain(ctx: GraphContext, id: string, guard = new Set<string>()): string {
  if (guard.has(id)) return '…loop…'
  guard.add(id)
  const node = nodeById(ctx, id)
  if (!node) return '?'
  const sources = edgesInto(ctx, id)
    .filter((edge) => !isParamHandle(edge.targetHandle))
    .map((edge) => textureChain(ctx, edge.source, guard))
  const prefix = sources.length ? `${sources.join(' + ')} → ` : ''
  return `${prefix}${node.data.name}`
}
