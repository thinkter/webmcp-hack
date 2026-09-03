/**
 * The WebMCP tool surface.
 *
 * These tools are the agent's whole view of a live show, so they are written as
 * operating tools rather than CRUD wrappers:
 *
 *  - every read answers a question an operator would actually ask ("is anything
 *    reaching the stream output?", "what is the audio doing?", "why is this
 *    black?") and reports live engine state next to the static graph;
 *  - every write goes through the same store actions the UI uses, tagged with
 *    `AGENT_ACTOR`, so the change appears on screen, in the history panel, and
 *    in `revert_agent_changes`;
 *  - every refusal explains what to do instead.
 *
 * Tools return plain text; `register.ts` wraps it into the MCP content shape.
 */

import { CATEGORY_ORDER, getOperator, operators, searchOperators } from '../engine/ops'
import type { OperatorCategory, OperatorSpec, ParamSpec } from '../engine/ops/kit'
import { engine } from '../engine/renderer'
import { audioEngine } from '../audio/engine'
import { midiEngine } from '../audio/midi'
import { mediaHub } from '../remote/hub'
import { joinUrl, outputUrl } from '../remote/links'
import {
  AGENT_ACTOR,
  formatParam,
  resolveParams,
  usePatchStore,
  type PatchState,
} from '../graph/store'
import { isParamHandle, paramHandle, paramKeyFromHandle, type PatchNode } from '../graph/types'
import {
  capLines,
  changedParams,
  driverEdge,
  edgesInto,
  edgesOutOf,
  fail,
  graphContext,
  isFreeInput,
  joinLines,
  liveState,
  matchNodes,
  nodeById,
  nodeLine,
  nodeRef,
  num,
  operatorBrief,
  operatorFull,
  operatorRich,
  optBool,
  optNumber,
  optRecord,
  optString,
  optStringList,
  paramDrivers,
  paramTable,
  relativeTime,
  reqString,
  resolveInputPort,
  resolveNode,
  resolveNodes,
  resolveOperator,
  resolveParamSpec,
  section,
  shorten,
  specOf,
  textureChain,
  walk,
  type GraphContext,
} from './describe'

export type AgentTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** True for tools that never mutate the patch. Surfaced as a WebMCP hint. */
  readOnly: boolean
  execute: (args: Record<string, unknown>) => Promise<string> | string
}

const store = (): PatchState => usePatchStore.getState()

// ----------------------------------------------------------------- schemas ----

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const str = (description: string) => ({ type: 'string', description })
const number = (description: string) => ({ type: 'number', description })
const boolean = (description: string) => ({ type: 'boolean', description })
const strings = (description: string) => ({ type: 'array', items: { type: 'string' }, description })

const NODE_REF =
  'A node id ("glitch-1") or a node name ("Glitch"). Names are matched case-insensitively; ' +
  'if a name is ambiguous the error lists the candidates.'

const PARAM_REF =
  'Parameter key ("amount") or inspector label ("Amount"), case-insensitive. ' +
  'Call describe_operator or inspect_graph with a nodeId to see the list.'

const POSITION = {
  type: 'object',
  description: 'Canvas position in graph units. Omit to have the editor find a free slot.',
  properties: { x: number('Horizontal position.'), y: number('Vertical position.') },
  required: ['x', 'y'],
  additionalProperties: false,
}

// -------------------------------------------------------------- inspection ----

function graphOverview(ctx: GraphContext): string {
  const status = engine.getStatus()
  const tops = ctx.plan.order
    .map((id) => nodeById(ctx, id))
    .filter((node): node is PatchNode => node !== undefined)
  const chops = ctx.plan.chopOrder
    .map((id) => nodeById(ctx, id))
    .filter((node): node is PatchNode => node !== undefined)

  const executing = tops.filter((node) => engine.hasTexture(node.id)).length
  const idle = tops.filter((node) => !ctx.needed.has(node.id)).map((node) => node.data.name)

  const header = [
    `PATCH "${ctx.state.name}"  ${ctx.state.resolution.width}\u00d7${ctx.state.resolution.height}` +
      `  ${ctx.nodes.length} nodes  ${ctx.edges.length} links  ${ctx.state.playing ? 'playing' : 'PAUSED'}`,
    `ENGINE ${status.state}${status.adapter ? ` on ${status.adapter}` : ''}` +
      `  ${status.fps} fps  ${num(status.frameMs, 1)} ms/frame  executing ${executing}/${tops.length} texture nodes` +
      `${status.error ? `  ERROR: ${status.error}` : ''}`,
    'Legend: id op "name" [live state] in:<port←source> mod:<param←signal> set:<changed params>',
    '',
  ]

  const textureLines = capLines(
    tops.map((node) => `  ${nodeLine(ctx, node)}`),
    26,
    'Pass nodeId to focus on one node.',
  )
  const signalLines = capLines(
    chops.map((node) => {
      const targets = edgesOutOf(ctx, node.id).map((edge) => {
        const target = nodeById(ctx, edge.target)
        const key = isParamHandle(edge.targetHandle)
          ? `.${paramKeyFromHandle(edge.targetHandle!)}`
          : `.${edge.targetHandle ?? 'in'}`
        return `${target?.data.name ?? edge.target}${key}`
      })
      return `  ${nodeLine(ctx, node)}${targets.length ? `  drives: ${targets.join(', ')}` : '  drives: nothing'}`
    }),
    16,
    'Call read_signals for values only.',
  )

  const issueLines = capLines(
    ctx.plan.issues.map((issue) => {
      const node = issue.nodeId ? nodeById(ctx, issue.nodeId) : undefined
      return `  ${issue.severity.toUpperCase()} ${node ? `${node.data.name} [${node.id}]: ` : ''}${issue.message}`
    }),
    10,
    'Call get_system_health for the full diagnostic list.',
  )

  return joinLines([
    ...header,
    ...section(`TEXTURE PATH (execution order, ${tops.length})`, textureLines, 'none'),
    '',
    ...section(`SIGNALS (${chops.length})`, signalLines, 'none — no signal operator is driving anything'),
    '',
    ...section(`ISSUES (${ctx.plan.issues.length})`, issueLines, 'none'),
    idle.length
      ? `\nIDLE (no output needs them): ${shorten(idle.join(', '), 200)}`
      : null,
  ])
}

function nodeDetail(ctx: GraphContext, node: PatchNode): string {
  const spec = specOf(node)
  const inputs = spec.inputs.map((port, index) => {
    const edge = ctx.edges.find(
      (candidate) => candidate.target === node.id && candidate.targetHandle === port.id,
    )
    const source = edge ? nodeById(ctx, edge.source) : undefined
    const tail = source
      ? `\u2190 ${nodeRef(source)}${port.delayed ? '  (DELAYED: previous frame, this is a feedback link)' : ''}`
      : `UNWIRED${port.optional ? ' (optional)' : ''}`
    return `  ${port.id} (index ${index}) "${port.label}" ${port.type}  ${tail}`
  })

  const downstream = edgesOutOf(ctx, node.id).map((edge) => {
    const target = nodeById(ctx, edge.target)
    const handle = edge.targetHandle ?? 'in'
    const label = isParamHandle(handle) ? `parameter ${paramKeyFromHandle(handle)}` : `input ${handle}`
    return `  \u2192 ${target ? nodeRef(target) : edge.target} ${label}  (${edge.data?.kind ?? 'texture'})`
  })

  const drivers = [...paramDrivers(ctx, node.id)].map(
    ([key, source]) =>
      `  ${key} \u2190 ${nodeRef(source)} (${getOperator(source.data.op)?.label ?? source.data.op}) = ${num(engine.signalValue(source.id))}`,
  )

  const media = engine.mediaEntry(node.id)
  const issues = ctx.plan.issues.filter((issue) => issue.nodeId === node.id)

  return joinLines([
    `NODE ${nodeRef(node)}`,
    `operator ${spec.id} "${spec.label}" \u00b7 ${spec.category} \u00b7 runtime ${spec.runtime}` +
      `${spec.td ? ` \u00b7 TD: ${spec.td}` : ''}`,
    spec.description,
    `state: ${liveState(ctx, node)}${node.data.enabled ? '' : ' \u2014 enable_node to switch it back on'}` +
      `  \u00b7 position ${Math.round(node.position.x)},${Math.round(node.position.y)}`,
    media
      ? `media: ${media.status.toUpperCase()} ${media.width}\u00d7${media.height} ${media.detail}` +
        `${media.error ? ` \u2014 ${media.error}` : ''}`
      : null,
    node.data.comment ? `comment: ${node.data.comment}` : null,
    '',
    ...section(`INPUTS (${spec.inputs.length})`, inputs, 'none — this operator generates its own signal'),
    ...section('OUTGOING', downstream, 'nothing — this node feeds no other operator'),
    ...section('SIGNAL-DRIVEN PARAMETERS', drivers, 'none'),
    '',
    'PARAMETERS (* = changed from default)',
    ...capLines(paramTable(ctx, node, spec), 34, 'Call describe_operator for the rest.'),
    ...(issues.length
      ? ['', 'ISSUES', ...issues.map((issue) => `  ${issue.severity.toUpperCase()} ${issue.message}`)]
      : []),
  ])
}

const inspectGraph: AgentTool = {
  name: 'inspect_graph',
  description:
    'Read the live patch: every operator node with its id, operator, name, enabled/bypass state, ' +
    'changed parameters, what is wired into each input, which signal operator drives which parameter, ' +
    'and whether it is actually executing this frame. Also lists the compiler issue list and which ' +
    'nodes are idle because no output needs them. Start here before changing anything. ' +
    'Pass nodeId to get full detail for one node (every parameter, its value, range, and whether a ' +
    'signal can drive it). Use get_media_topology instead when the question is about cameras and outputs.',
  readOnly: true,
  inputSchema: schema({ nodeId: str(`Optional. ${NODE_REF} Focuses the report on that one node.`) }),
  execute: (args) => {
    const ctx = graphContext()
    const ref = optString(args, 'nodeId')
    if (!ref) return graphOverview(ctx)
    return nodeDetail(ctx, resolveNode(ref, ctx))
  },
}

const listOperators: AgentTool = {
  name: 'list_operators',
  description:
    'Browse the operator catalog — the set of things this application can do. Grouped by category ' +
    '(sources, generators, filters, warp, composite, control, audio, outputs) with operator id, label, ' +
    'a one-line description, the TouchDesigner equivalent, input ports, and which parameters a signal ' +
    'can drive. Filter with query (free text over labels, descriptions, keywords and TD names) or ' +
    'category. Narrow results get the detailed form; broad results get a compact one — call ' +
    'describe_operator for a single operator in full.',
  readOnly: true,
  inputSchema: schema({
    query: str('Optional free text, e.g. "blur", "feedback", "audio", "Movie File In TOP".'),
    category: str(
      `Optional category filter. One of: ${CATEGORY_ORDER.map(([id]) => id).join(', ')}.`,
    ),
  }),
  execute: (args) => {
    const query = optString(args, 'query')
    const category = optString(args, 'category')?.toLowerCase()

    if (category && !CATEGORY_ORDER.some(([id, label]) => id === category || label.toLowerCase() === category)) {
      fail(
        `"${category}" is not a category. Valid categories: ${CATEGORY_ORDER.map(([id, label]) => `${id} (${label})`).join(', ')}.`,
      )
    }

    let found: OperatorSpec[] = query ? searchOperators(query) : operators
    if (category) {
      found = found.filter(
        (spec) =>
          spec.category === category ||
          (CATEGORY_ORDER.find(([id]) => id === spec.category)?.[1] ?? '').toLowerCase() === category,
      )
    }

    if (!found.length) {
      fail(
        `No operator matches ${query ? `query "${query}"` : ''}${query && category ? ' and ' : ''}` +
          `${category ? `category "${category}"` : ''}. Try a broader query, or call list_operators with no arguments.`,
      )
    }

    const rich = found.length <= 24
    const lines: string[] = [
      `OPERATORS ${found.length}${found.length === operators.length ? '' : ` of ${operators.length}`}` +
        `${query ? `  query="${query}"` : ''}${category ? `  category="${category}"` : ''}` +
        `${rich ? '' : '  (compact form; add query= or category= for port and parameter detail)'}`,
    ]

    for (const [id, label] of CATEGORY_ORDER) {
      const group = found.filter((spec) => spec.category === (id as OperatorCategory))
      if (!group.length) continue
      lines.push('', `${label.toUpperCase()} (${group.length})`)
      for (const spec of group) {
        if (rich) lines.push(...operatorRich(spec))
        else lines.push(operatorBrief(spec))
      }
    }

    lines.push(
      '',
      'Next: describe_operator for one operator in full, create_node to place one, insert_effect to add one into an existing link.',
    )
    return joinLines(lines)
  },
}

const describeOperator: AgentTool = {
  name: 'describe_operator',
  description:
    'Full reference for one operator: what it does, its TouchDesigner equivalent, every input and ' +
    'output port with its type (including delayed feedback ports), and every parameter with kind, ' +
    'range, unit, default, menu options, help text, and whether a signal operator can drive it. ' +
    'Call this before set_parameter on an operator you have not used yet.',
  readOnly: true,
  inputSchema: schema(
    { operator: str('Operator id ("glitch") or label ("Glitch"). See list_operators.') },
    ['operator'],
  ),
  execute: (args) =>
    operatorFull(resolveOperator(reqString(args, 'operator', 'Pass an operator id such as "blur".'))),
}

// -------------------------------------------------------- media topology ----

const EXTERNAL_RUNTIMES = new Set(['external', 'raster'])

function outputDestination(node: PatchNode): string {
  const spec = getOperator(node.data.op)
  const params = resolveParams(node)
  if (spec?.id === 'remote-out') {
    const slot = String(params.slot ?? 'main')
    const room = mediaHub.room
    return room
      ? `projector/second screen at ${outputUrl(room, slot)}`
      : `slot "${slot}" — no room joined yet, so no projector can subscribe (open the Session panel to start one)`
  }
  return `program monitor${params.name ? ` ("${String(params.name)}")` : ''} and any attached display surface`
}

function sourceStatusLine(ctx: GraphContext, node: PatchNode): string {
  const spec = specOf(node)
  const params = resolveParams(node)
  const media = engine.mediaEntry(node.id)
  const feeds = edgesOutOf(ctx, node.id)
    .map((edge) => nodeById(ctx, edge.target)?.data.name ?? edge.target)
    .join(', ')

  let detail: string
  if (media) {
    detail =
      `media ${media.status.toUpperCase()}` +
      (media.width ? ` ${media.width}\u00d7${media.height}` : ' (no frames yet)') +
      (media.detail ? `  ${shorten(media.detail, 46)}` : '') +
      (media.error ? `  ERROR: ${media.error}` : '')
  } else if (!ctx.engineRunning) {
    detail = 'media unknown — the render engine is not running'
  } else {
    detail = 'media not yet registered by the engine (node may be disabled)'
  }

  if (spec.id === 'remote-in') {
    const slot = String(params.slot ?? '')
    const stream = mediaHub.streams.get(slot)
    detail +=
      `  slot="${slot}"  ` +
      (stream
        ? `publisher "${stream.label}" connected ${relativeTime(stream.since)}`
        : mediaHub.room
          ? `no publisher on this slot — have one open ${joinUrl(mediaHub.room, slot || 'cam-1')}`
          : 'no room joined, so no phone can publish yet')
  }

  return `  ${node.id}  ${spec.id} "${node.data.name}"  ${detail}  \u2192 feeds: ${feeds || 'nothing'}`
}

const getMediaTopology: AgentTool = {
  name: 'get_media_topology',
  description:
    'The end-to-end signal path, from external sources to outputs: cameras, video files, screen ' +
    'capture and remote phone streams with their live status and resolution; the generators feeding ' +
    'the texture graph; and every output with the chain that reaches it, whether it currently has a ' +
    'live signal, and where the picture is going (program monitor or a /output projector link). ' +
    'Use this to answer "is anything on screen?" and "where does the stream output come from?".',
  readOnly: true,
  inputSchema: schema({}),
  execute: () => {
    const ctx = graphContext()
    const external: PatchNode[] = []
    const generators: PatchNode[] = []
    const outputs: PatchNode[] = []

    for (const node of ctx.nodes) {
      const spec = getOperator(node.data.op)
      if (!spec) continue
      if (spec.runtime === 'output') outputs.push(node)
      else if (EXTERNAL_RUNTIMES.has(spec.runtime)) external.push(node)
      else if (!spec.inputs.length && spec.family === 'TOP') generators.push(node)
    }

    const outputLines: string[] = []
    for (const node of outputs) {
      const planNode = ctx.plan.nodes.get(node.id)
      const feeding = planNode?.inputs[0] ?? null
      const feedingNode = feeding ? nodeById(ctx, feeding) : undefined
      const live = feeding !== null && ctx.engineRunning && engine.hasTexture(feeding)
      const verdict = !feeding
        ? 'NO SIGNAL \u2014 its Texture input is unwired. Use route_source_to_output or connect_nodes.'
        : !ctx.engineRunning
          ? `signal path present (from ${feedingNode?.data.name ?? feeding}) but the engine is not running`
          : live
            ? 'LIVE'
            : `NO SIGNAL \u2014 ${feedingNode?.data.name ?? feeding} produced no texture last frame (check it is enabled and its own inputs are wired)`
      outputLines.push(
        `  ${node.id}  ${node.data.op} "${node.data.name}"  ${verdict}`,
        `      chain: ${shorten(textureChain(ctx, node.id), 180)}`,
        `      destination: ${outputDestination(node)}`,
      )
    }

    const hub =
      `REMOTE SESSION: ${mediaHub.status}` +
      (mediaHub.room ? ` room ${mediaHub.room}` : ' (no room)') +
      (mediaHub.streams.size
        ? `  publishers: ${[...mediaHub.streams.values()]
            .map((stream) => `${stream.slot} "${stream.label}" (${relativeTime(stream.since)})`)
            .join(', ')}`
        : '  publishers: none')

    return joinLines([
      `MEDIA TOPOLOGY  \u00b7  engine ${engine.getStatus().state}  \u00b7  graph ${ctx.state.resolution.width}\u00d7${ctx.state.resolution.height}`,
      '',
      ...section(
        `EXTERNAL SOURCES (${external.length})`,
        capLines(external.map((node) => sourceStatusLine(ctx, node)), 12, 'Call inspect_source for one of them.'),
        'none — this patch has no camera, video, screen or remote input',
      ),
      '',
      ...section(
        `GENERATED SOURCES (${generators.length})`,
        capLines(
          generators.map(
            (node) =>
              `  ${node.id}  ${node.data.op} "${node.data.name}"  ${liveState(ctx, node)}  \u2192 feeds: ${
                edgesOutOf(ctx, node.id)
                  .map((edge) => nodeById(ctx, edge.target)?.data.name ?? edge.target)
                  .join(', ') || 'nothing'
              }`,
          ),
          10,
          'Call inspect_graph for all of them.',
        ),
        'none',
      ),
      '',
      ...section(
        `OUTPUTS (${outputs.length})`,
        outputLines,
        'NONE — with no Out operator nothing can reach the monitor. Create one with create_node operator="out".',
      ),
      '',
      hub,
    ])
  },
}

const inspectSource: AgentTool = {
  name: 'inspect_source',
  description:
    'Detail on one input source (camera, video file, image, screen capture, remote phone stream or ' +
    'text layer): live media status and resolution, the device or URL it is using, everything ' +
    'downstream of it, and any problem stopping it from producing frames. Use get_media_topology ' +
    'first if you do not know which sources exist.',
  readOnly: true,
  inputSchema: schema({ node: str(`The source node. ${NODE_REF}`) }, ['node']),
  execute: (args) => {
    const ctx = graphContext()
    const node = resolveNode(reqString(args, 'node', 'Pass a source node id or name.'), ctx)
    const spec = specOf(node)
    if (!EXTERNAL_RUNTIMES.has(spec.runtime) && spec.inputs.length) {
      fail(
        `${nodeRef(node)} is a ${spec.category} operator (${spec.label}), not an input source. ` +
          'Call inspect_graph with that nodeId for its detail, or get_media_topology to list the real sources.',
      )
    }

    const media = engine.mediaEntry(node.id)
    const downstream = walk(ctx, node.id, 'downstream')
    return joinLines([
      nodeDetail(ctx, node),
      '',
      `LIVE MEDIA: ${
        media
          ? `${media.status} ${media.width}\u00d7${media.height} ${media.detail}${media.error ? ` \u2014 ${media.error}` : ''}`
          : ctx.engineRunning
            ? 'the engine has not registered this source (it may be disabled)'
            : 'unknown; the render engine is not running'
      }`,
      ...section(
        `DOWNSTREAM (${downstream.length})`,
        capLines(
          downstream.map((hop) => `  ${'  '.repeat(hop.depth - 1)}${nodeRef(hop.node)} ${hop.via}`),
          20,
          'Call trace_dependencies for the full walk.',
        ),
        'nothing is connected to this source, so its pixels go nowhere',
      ),
    ])
  },
}

const inspectOutput: AgentTool = {
  name: 'inspect_output',
  description:
    'Detail on one output: whether it currently has a live signal, the whole chain feeding it, the ' +
    'display grade parameters applied to it, and where the picture is going (program monitor, or a ' +
    '/output link for a projector). Use this when someone says a screen is black.',
  readOnly: true,
  inputSchema: schema({ node: str(`The output node. ${NODE_REF}`) }, ['node']),
  execute: (args) => {
    const ctx = graphContext()
    const node = resolveNode(reqString(args, 'node', 'Pass an output node id or name, e.g. "out-1".'), ctx)
    const spec = specOf(node)
    if (spec.runtime !== 'output') {
      const outputs = ctx.nodes.filter((candidate) => getOperator(candidate.data.op)?.runtime === 'output')
      fail(
        `${nodeRef(node)} is not an output operator (it is ${spec.label}). ` +
          `Outputs in this patch: ${outputs.map((entry) => nodeRef(entry)).join(', ') || 'none'}.`,
      )
    }

    const planNode = ctx.plan.nodes.get(node.id)
    const feeding = planNode?.inputs[0] ?? null
    const upstream = walk(ctx, node.id, 'upstream')

    return joinLines([
      nodeDetail(ctx, node),
      '',
      `SIGNAL: ${
        !feeding
          ? 'NONE \u2014 the Texture input is unwired'
          : !ctx.engineRunning
            ? 'unknown \u2014 the render engine is not running'
            : engine.hasTexture(feeding)
              ? 'LIVE'
              : `NONE \u2014 ${nodeById(ctx, feeding)?.data.name ?? feeding} produced no texture last frame`
      }`,
      `CHAIN: ${shorten(textureChain(ctx, node.id), 220)}`,
      `DESTINATION: ${outputDestination(node)}`,
      ...section(
        `UPSTREAM (${upstream.length})`,
        capLines(
          upstream.map((hop) => `  ${'  '.repeat(hop.depth - 1)}${nodeRef(hop.node)} ${hop.via}`),
          20,
          'Call trace_dependencies for the full walk.',
        ),
        'nothing',
      ),
    ])
  },
}

const traceDependencies: AgentTool = {
  name: 'trace_dependencies',
  description:
    'Everything that contributes to a node and everything it affects, nearest first, with each link ' +
    'marked as a texture link or a signal (parameter) link, and delayed feedback links called out. ' +
    'Use this before deleting or rewiring something, to see what you would break.',
  readOnly: true,
  inputSchema: schema({ node: str(`The node to trace. ${NODE_REF}`) }, ['node']),
  execute: (args) => {
    const ctx = graphContext()
    const node = resolveNode(reqString(args, 'node', 'Pass a node id or name.'), ctx)
    const upstream = walk(ctx, node.id, 'upstream')
    const downstream = walk(ctx, node.id, 'downstream')
    const render = (hop: { node: PatchNode; depth: number; via: string }) =>
      `  ${'  '.repeat(Math.min(6, hop.depth - 1))}${hop.depth}. ${nodeRef(hop.node)} ` +
      `${getOperator(hop.node.data.op)?.label ?? hop.node.data.op} \u00b7 ${hop.via}`

    return joinLines([
      `TRACE ${nodeRef(node)} (${specOf(node).label}) \u00b7 ${liveState(ctx, node)}`,
      '',
      ...section(
        `UPSTREAM \u2014 contributes to this node (${upstream.length})`,
        capLines(upstream.map(render), 24, 'Trace an intermediate node for the rest.'),
        'nothing feeds this node',
      ),
      '',
      ...section(
        `DOWNSTREAM \u2014 affected by this node (${downstream.length})`,
        capLines(downstream.map(render), 24, 'Trace an intermediate node for the rest.'),
        'nothing depends on this node, so changes to it are invisible',
      ),
      '',
      ctx.plan.feedbacks.length
        ? `FEEDBACK OPERATORS in this patch: ${ctx.plan.feedbacks
            .map((id) => nodeById(ctx, id)?.data.name ?? id)
            .join(', ')} (their delayed input reads the previous frame)`
        : null,
    ])
  },
}

const getSystemHealth: AgentTool = {
  name: 'get_system_health',
  description:
    'The diagnostic tool: call it whenever something looks wrong. GPU adapter, engine state, fps and ' +
    'frame time, texture and pipeline counts, shader compile errors with the node they belong to, ' +
    'audio input state with live level and detected BPM, MIDI state and devices, remote session state ' +
    'and connected publishers, and the full compiler issue list for the patch.',
  readOnly: true,
  inputSchema: schema({}),
  execute: () => {
    const ctx = graphContext()
    const status = engine.getStatus()
    const frame = audioEngine.frame

    const shaderErrors: string[] = []
    for (const [nodeId, errors] of status.shaderErrors) {
      const node = nodeById(ctx, nodeId)
      for (const error of errors.slice(0, 3)) {
        shaderErrors.push(
          `  ${node ? nodeRef(node) : nodeId}${error.line ? ` line ${error.line}` : ''}: ${shorten(error.message, 140)}`,
        )
      }
    }

    return joinLines([
      `ENGINE ${status.state}${status.error ? `  ERROR: ${status.error}` : ''}`,
      status.hint ? `  hint: ${status.hint}` : null,
      `  adapter: ${status.adapter ?? 'none — WebGPU may be unavailable in this browser'}`,
      `  ${status.fps} fps  ${num(status.frameMs, 2)} ms/frame  target ${ctx.state.targetFps} fps  ${
        ctx.state.playing ? 'playing' : 'PAUSED (timeline frozen)'
      }`,
      `  render ${status.resolution.width}\u00d7${status.resolution.height}  executing ${status.executedNodes} nodes` +
        `  textures live ${status.textures.live}/pooled ${status.textures.pooled} (${status.textures.allocations} allocations)` +
        `  pipelines ${status.pipelines}`,
      '',
      `AUDIO ${audioEngine.state}${audioEngine.error ? `  ERROR: ${audioEngine.error}` : ''}` +
        `  device ${audioEngine.deviceId ?? 'default/none'}`,
      `  level ${num(frame.level)}  peak ${num(frame.peak)}  beat envelope ${num(frame.beat)}` +
        `  bpm ${frame.bpm ? num(frame.bpm, 1) : 'unknown'}  ${frame.active ? 'receiving audio' : 'SILENT/not started'}`,
      audioEngine.state !== 'running'
        ? '  note: audio-reactive signal operators read 0 until the user starts the microphone from the toolbar.'
        : null,
      '',
      `MIDI ${midiEngine.state}${midiEngine.error ? `  ERROR: ${midiEngine.error}` : ''}` +
        `  inputs: ${midiEngine.inputs.map((input) => input.name).join(', ') || 'none'}` +
        `${midiEngine.lastTouched ? `  last touched ch${midiEngine.lastTouched.channel} cc${midiEngine.lastTouched.controller}` : ''}`,
      '',
      `REMOTE ${mediaHub.status}${mediaHub.error ? `  ERROR: ${mediaHub.error}` : ''}` +
        `  room ${mediaHub.room ?? 'none'}  publishers ${mediaHub.streams.size}`,
      ...[...mediaHub.streams.values()].map(
        (stream) => `  slot "${stream.slot}" ← "${stream.label}" since ${relativeTime(stream.since)}`,
      ),
      '',
      ...section(
        `SHADER COMPILE ERRORS (${shaderErrors.length})`,
        capLines(shaderErrors, 8, 'Fix them one node at a time.'),
        'none',
      ),
      '',
      ...section(
        `PATCH ISSUES (${ctx.plan.issues.length})`,
        capLines(
          ctx.plan.issues.map((issue) => {
            const node = issue.nodeId ? nodeById(ctx, issue.nodeId) : undefined
            return `  ${issue.severity.toUpperCase()} ${node ? `${nodeRef(node)}: ` : ''}${issue.message}`
          }),
          16,
          'Call inspect_graph for the rest.',
        ),
        'none — the patch compiles cleanly',
      ),
    ])
  },
}

const getRecentChanges: AgentTool = {
  name: 'get_recent_changes',
  description:
    'The change log, newest first: who changed what and when, with the nodes each change touched. ' +
    'Human edits and agent edits are both recorded, so use this to see what a collaborator just did ' +
    'before you change the same thing, or to check what you yourself changed before calling ' +
    'revert_agent_changes.',
  readOnly: true,
  inputSchema: schema({
    sinceSeconds: number('Optional. Only changes newer than this many seconds ago.'),
    actorKind: str('Optional filter: "human" or "agent".'),
    limit: number('Optional maximum number of entries to return (default 25).'),
  }),
  execute: (args) => {
    const since = optNumber(args, 'sinceSeconds')
    const kind = optString(args, 'actorKind')?.toLowerCase()
    const limit = Math.max(1, Math.min(80, optNumber(args, 'limit') ?? 25))
    if (kind && kind !== 'human' && kind !== 'agent') {
      fail(`actorKind must be "human" or "agent"; received "${kind}".`)
    }

    const now = Date.now()
    const cutoff = since === undefined ? 0 : now - since * 1000
    const ctx = graphContext()
    const matching = ctx.state.changeLog
      .filter((record) => record.at >= cutoff && (!kind || record.actor.kind === kind))
      .slice()
      .reverse()

    if (!matching.length) {
      return `No changes recorded${since ? ` in the last ${since}s` : ''}${kind ? ` by a ${kind}` : ''}. The change log holds ${ctx.state.changeLog.length} entries in total.`
    }

    const lines = matching.slice(0, limit).map((record) => {
      const targets = record.targets
        .map((id) => nodeById(ctx, id)?.data.name ?? id)
        .filter((name, index, all) => all.indexOf(name) === index)
      return (
        `  ${relativeTime(record.at, now).padEnd(12)} ${record.actor.name.padEnd(6)} (${record.actor.kind})` +
        `  ${record.kind.padEnd(10)} ${shorten(record.label, 96)}` +
        (targets.length ? `  [${shorten(targets.join(', '), 60)}]` : '')
      )
    })

    return joinLines([
      `CHANGES ${matching.length} match${since ? ` in the last ${since}s` : ''}${kind ? `, actor ${kind}` : ''}` +
        `  (undo stack ${ctx.state.history.length}, redo stack ${ctx.state.undone.length})`,
      ...capLines(lines, limit, 'Raise limit or lower sinceSeconds.'),
    ])
  },
}

const readSignals: AgentTool = {
  name: 'read_signals',
  description:
    'The current numeric value of every signal (CHOP) operator, plus what each one drives and the live ' +
    'audio analysis behind it. Call this before wiring audio reactivity, to see whether the music is ' +
    'actually reaching the app and which band is moving.',
  readOnly: true,
  inputSchema: schema({}),
  execute: () => {
    const ctx = graphContext()
    const frame = audioEngine.frame
    const signals = ctx.nodes.filter((node) => getOperator(node.data.op)?.family === 'CHOP')

    const lines = signals.map((node) => {
      const spec = getOperator(node.data.op)
      const targets = edgesOutOf(ctx, node.id).map((edge) => {
        const target = nodeById(ctx, edge.target)
        const handle = edge.targetHandle ?? ''
        const where = isParamHandle(handle) ? paramKeyFromHandle(handle) : (handle || 'in')
        return `${target?.data.name ?? edge.target}.${where}`
      })
      return (
        `  ${node.id.padEnd(14)} ${(spec?.label ?? node.data.op).padEnd(12)} "${node.data.name}"` +
        `  = ${num(engine.signalValue(node.id)).padEnd(9)}` +
        `  drives: ${targets.join(', ') || 'nothing (wire it with make_parameter_reactive or connect_nodes)'}` +
        `${node.data.enabled ? '' : '  DISABLED'}`
      )
    })

    return joinLines([
      `SIGNALS (${signals.length})  engine ${engine.getStatus().state}  ${ctx.state.playing ? 'playing' : 'PAUSED — signals are frozen'}`,
      ...section('', capLines(lines, 24, 'Delete unused signal operators, or inspect one node at a time.'), 'none in this patch'),
      '',
      `AUDIO ANALYSIS: ${audioEngine.state}  level ${num(frame.level)}  peak ${num(frame.peak)}` +
        `  beat ${num(frame.beat)}${frame.beatPulse ? ' (onset this frame)' : ''}  bpm ${frame.bpm ? num(frame.bpm, 1) : 'unknown'}`,
      audioEngine.state === 'running'
        ? `bands: bass ${num(audioEngine.bandEnergy(20, 140))}  low-mid ${num(audioEngine.bandEnergy(140, 400))}` +
          `  mid ${num(audioEngine.bandEnergy(400, 2000))}  high-mid ${num(audioEngine.bandEnergy(2000, 6000))}` +
          `  treble ${num(audioEngine.bandEnergy(6000, 16000))}`
        : 'bands: unavailable — the microphone is not running, so every audio signal reads 0.',
    ])
  },
}

// --------------------------------------------------------------- operation ----

/**
 * The single validation path for writing a parameter, shared by set_parameter,
 * set_parameters, create_node, and make_parameter_reactive. Refuses when the
 * parameter is currently driven by a signal, because a fixed value would be
 * overwritten on the next frame and the call would look like a silent no-op.
 */
/**
 * Rejects values the store would silently coerce to the default. `coerceParam`
 * is deliberately forgiving for the UI, but for an agent a quiet fallback looks
 * exactly like success, so a bad value has to be an error with the legal range.
 */
function validateValue(spec: OperatorSpec, param: ParamSpec, value: unknown): void {
  const where = `${spec.label}.${param.key} ("${param.label}")`
  const got = typeof value === 'string' ? `"${value}"` : JSON.stringify(value) ?? 'undefined'

  switch (param.kind) {
    case 'float':
    case 'int':
      if (typeof value === 'boolean' || value === null || !Number.isFinite(Number(value))) {
        fail(
          `${where} is a ${param.kind} in the range ${param.min ?? '-∞'}..${param.max ?? '∞'}` +
            `${param.unit ? ` ${param.unit}` : ''}, but ${got} is not a number. Nothing was changed.`,
        )
      }
      break
    case 'bool':
      if (!(typeof value === 'boolean' || value === 0 || value === 1 || value === 'true' || value === 'false')) {
        fail(`${where} is a switch; pass true or false, not ${got}. Nothing was changed.`)
      }
      break
    case 'menu': {
      const options = param.options ?? []
      const list = options.map((option, index) => `${index}=${option}`).join(', ')
      if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
        if (!options.some((option) => option.toLowerCase() === value.trim().toLowerCase())) {
          fail(`${where} has no option ${got}. Options are: ${list}. Nothing was changed.`)
        }
      } else if (!Number.isFinite(Number(value))) {
        fail(`${where} is a menu; pass an option name or its index. Options are: ${list}.`)
      }
      break
    }
    case 'color':
      if (typeof value === 'string') {
        if (!/^#?[0-9a-f]{3,8}$/i.test(value.trim())) {
          fail(`${where} is a colour; pass "#rrggbb", "#rrggbbaa", or [r,g,b,a] with channels 0..1. Got ${got}.`)
        }
      } else if (!Array.isArray(value)) {
        fail(`${where} is a colour; pass "#rrggbb" or [r,g,b,a] with channels 0..1. Got ${got}.`)
      }
      break
    default:
      if (value !== null && typeof value === 'object') {
        fail(`${where} is text; pass a string, not ${got}.`)
      }
  }
}

function applyParameter(ref: string, paramRef: string, value: unknown): string {
  const ctx = graphContext()
  const node = resolveNode(ref, ctx)
  const spec = specOf(node)
  const param = resolveParamSpec(spec, paramRef)
  validateValue(spec, param, value)

  if (param.system) {
    fail(
      `${nodeRef(node)}.${param.key} ("${param.label}") is written by the engine every frame, so setting ` +
        'it would have no effect. Nothing was changed.',
    )
  }

  const driving = driverEdge(ctx, node.id, param.key)
  if (driving) {
    const source = nodeById(ctx, driving.source)
    fail(
      `${nodeRef(node)}.${param.key} is driven by signal operator ${source ? nodeRef(source) : driving.source}, ` +
        'so a fixed value would be overwritten on the next frame. Nothing was changed. Either call ' +
        `disconnect with to="${node.id}" toParameter="${param.key}" first, or change the signal instead ` +
        `(set parameters on ${source ? source.data.name : 'the signal operator'}, or call ` +
        'make_parameter_reactive with new low/high values).',
    )
  }

  const before = resolveParams(node)[param.key]
  store().setParam(node.id, param.key, value, AGENT_ACTOR)

  const after = resolveParams(nodeById(graphContext(), node.id) ?? node)[param.key]
  const beforeText = formatParam(param, before)
  const afterText = formatParam(param, after)
  const coerced =
    param.kind === 'menu' ? `${afterText} (index ${String(after)})` : afterText
  const requested = typeof value === 'string' ? `"${value}"` : JSON.stringify(value)
  const clamped =
    (param.kind === 'float' || param.kind === 'int') && Number(after) !== Number(value)
      ? `  (clamped from ${String(value)}; the range is ${param.min ?? '-∞'}..${param.max ?? '∞'})`
      : ''

  if (beforeText === afterText) {
    return `${node.data.name}.${param.key} unchanged — it is already ${coerced} (you requested ${requested}).`
  }
  return `${node.data.name}.${param.key} = ${coerced}  (was ${beforeText}; requested ${requested})${clamped}`
}

function configure(nodeId: string, params: Record<string, unknown>): string[] {
  return Object.entries(params).map(([key, value]) => applyParameter(nodeId, key, value))
}

/** Applies parameters and reports them as one compact `key=value` list. */
function configureCompact(nodeId: string, params: Record<string, unknown>): string {
  configure(nodeId, params)
  const ctx = graphContext()
  const node = nodeById(ctx, nodeId)
  if (!node) return ''
  const spec = specOf(node)
  const values = resolveParams(node)
  return Object.keys(params)
    .map((key) => {
      const param = resolveParamSpec(spec, key)
      return `${param.key}=${formatParam(param, values[param.key])}`
    })
    .join(' ')
}

/** The single wiring path. Returns a description, or fails with the store's reason. */
function connectCore(
  fromRef: string,
  toRef: string,
  toInputRef?: string,
  toParamRef?: string,
): string {
  const ctx = graphContext()
  const from = resolveNode(fromRef, ctx)
  const to = resolveNode(toRef, ctx)
  const fromSpec = specOf(from)
  const toSpec = specOf(to)

  if (!fromSpec.outputs.length) {
    fail(
      `${nodeRef(from)} is a terminal ${fromSpec.label} operator with no output, so nothing can be taken ` +
        'from it. Connect from the operator that feeds it instead.',
    )
  }

  let targetHandle: string
  let chose = ''

  if (toParamRef) {
    const param = resolveParamSpec(toSpec, toParamRef)
    if (!param.modulatable) {
      fail(
        `${toSpec.label}.${param.key} cannot be driven by a signal (kind ${param.kind}` +
          `${param.system ? ', engine-written' : ''}). Modulatable parameters on ${toSpec.label}: ` +
          `${toSpec.params.filter((entry) => entry.modulatable).map((entry) => entry.key).join(', ') || 'none'}.`,
      )
    }
    if (fromSpec.family !== 'CHOP') {
      fail(
        `Only signal (CHOP) operators can drive a parameter, and ${nodeRef(from)} is a texture operator ` +
          `(${fromSpec.label}). Use make_parameter_reactive, or create a signal operator such as lfo, ` +
          'audio-band or beat first.',
      )
    }
    targetHandle = paramHandle(param.key)
  } else if (toInputRef) {
    targetHandle = resolveInputPort(toSpec, toInputRef).id
  } else {
    const wanted = fromSpec.family === 'CHOP' ? 'number' : 'texture'
    const free = toSpec.inputs.filter(
      (port) => port.type === wanted && isFreeInput(ctx, to.id, port.id),
    )
    if (!free.length) {
      const occupied = toSpec.inputs.filter((port) => port.type === wanted)
      fail(
        occupied.length
          ? `Every ${wanted} input on ${nodeRef(to)} is already connected (${occupied
              .map((port) => port.id)
              .join(', ')}). Disconnect one first, use insert_effect to splice into an existing link, or ` +
            'pass toInput explicitly to replace nothing.'
          : `${nodeRef(to)} (${toSpec.label}) has no ${wanted} input.` +
            (wanted === 'number'
              ? ' To drive one of its parameters with this signal, pass toParameter instead.'
              : ' It is probably a generator or a source.'),
      )
    }
    targetHandle = free[0].id
    chose = `  (chose input "${free[0].label}" [${free[0].id}], the first free ${wanted} input)`
  }

  const connection = {
    source: from.id,
    sourceHandle: fromSpec.outputs[0].id,
    target: to.id,
    targetHandle,
  }
  const check = store().connect(connection, AGENT_ACTOR)
  if (!check.ok) {
    fail(
      `Refused to connect ${nodeRef(from)} → ${nodeRef(to)} (${targetHandle}): ${check.reason} ` +
        'Nothing was changed. Call inspect_graph to see what already occupies that input, or ' +
        'trace_dependencies to check for a loop.',
    )
  }

  const what = isParamHandle(targetHandle)
    ? `parameter ${paramKeyFromHandle(targetHandle)}`
    : `input ${targetHandle}`
  return `Connected ${nodeRef(from)} → ${nodeRef(to)} ${what}${chose}`
}

/** Resolves a reference to an existing node, or creates one from an operator id. */
function ensureNode(
  ref: string,
  position?: { x: number; y: number },
): { node: PatchNode; created: boolean } {
  const ctx = graphContext()
  const matches = matchNodes(ref, ctx)
  if (matches.length === 1) return { node: matches[0], created: false }
  if (matches.length > 1) {
    fail(
      `"${ref}" matches ${matches.length} nodes: ${matches.map((node) => nodeRef(node)).join(', ')}. ` +
        'Pass the exact node id you mean.',
    )
  }

  const spec = resolveOperator(ref)
  const id = store().addOperator(spec.id, position, AGENT_ACTOR)
  const node = nodeById(graphContext(), id)
  if (!node) fail(`Created ${spec.label} but could not read node ${id} back from the store.`)
  return { node, created: true }
}

/** Wires a left-to-right texture chain, repairing links that point elsewhere. */
function wireChain(chain: PatchNode[]): string[] {
  const reports: string[] = []
  for (let index = 0; index + 1 < chain.length; index += 1) {
    const from = chain[index]
    const to = chain[index + 1]
    const ctx = graphContext()
    const port = specOf(to).inputs.find((entry) => entry.type === 'texture' && !entry.delayed)
    if (!port) {
      fail(
        `${nodeRef(to)} (${specOf(to).label}) has no texture input, so it cannot sit in a video chain. ` +
          `The chain was built up to ${nodeRef(from)}.`,
      )
    }

    const existing = ctx.edges.find(
      (edge) => edge.target === to.id && edge.targetHandle === port.id,
    )
    if (existing?.source === from.id) {
      reports.push(`Already connected: ${from.data.name} → ${to.data.name}.${port.id}`)
      continue
    }
    if (existing) {
      const previous = nodeById(ctx, existing.source)
      store().disconnect(existing.id, AGENT_ACTOR)
      reports.push(
        `Replaced the link into ${to.data.name}.${port.id} (was from ${previous?.data.name ?? existing.source})`,
      )
    }
    reports.push(connectCore(from.id, to.id, port.id))
  }
  return reports
}

const createNodeTool: AgentTool = {
  name: 'create_node',
  description:
    'Place a new operator on the canvas. Optionally name it, position it, set parameters, and connect ' +
    'it immediately. The operator id must come from list_operators; on a miss the error suggests the ' +
    'closest matches. Use insert_effect instead when you want the new operator spliced into an ' +
    'existing link, and route_source_to_output when you want a whole chain built.',
  readOnly: false,
  inputSchema: schema(
    {
      operator: str('Operator id from list_operators, e.g. "blur", "camera", "audio-band", "out".'),
      name: str('Optional display name. Defaults to the operator label.'),
      position: POSITION,
      params: {
        type: 'object',
        description:
          'Optional parameter values, keyed by parameter key or label. Menu parameters accept the ' +
          'option name ("Screen") or its index (4). Values are clamped to the parameter range and the ' +
          'result is reported back.',
        additionalProperties: true,
      },
      connectTo: {
        type: 'object',
        description:
          'Optional immediate connection. Give `to` to feed another node, and/or `from` to feed the ' +
          'new node. Within `to`, use toInput for a texture input or toParameter to drive a parameter.',
        properties: {
          to: str(`Node the new operator should feed. ${NODE_REF}`),
          toInput: str('Input port id, label, or index on that node. Omit to pick the first free one.'),
          toParameter: str(`Parameter on that node to drive instead of an input. ${PARAM_REF}`),
          from: str(`Node that should feed the new operator. ${NODE_REF}`),
        },
        additionalProperties: false,
      },
    },
    ['operator'],
  ),
  execute: (args) => {
    const spec = resolveOperator(
      reqString(args, 'operator', 'Call list_operators to find one, e.g. operator="blur".'),
    )
    const params = optRecord(args, 'params') ?? {}
    // Validate every parameter name before creating anything, so a typo cannot
    // leave a half-configured node behind.
    for (const key of Object.keys(params)) resolveParamSpec(spec, key)

    const rawPosition = optRecord(args, 'position')
    const position = rawPosition
      ? { x: optNumber(rawPosition, 'x') ?? 0, y: optNumber(rawPosition, 'y') ?? 0 }
      : undefined

    const link = optRecord(args, 'connectTo')
    const id = store().addOperator(spec.id, position, AGENT_ACTOR)

    const name = optString(args, 'name')
    if (name) store().setField(id, 'name', name, AGENT_ACTOR)

    const reports = configure(id, params)
    if (link) {
      const from = optString(link, 'from')
      if (from) reports.push(connectCore(from, id))
      const to = optString(link, 'to')
      if (to) reports.push(connectCore(id, to, optString(link, 'toInput'), optString(link, 'toParameter')))
      if (!from && !to) {
        reports.push('connectTo was given without `to` or `from`, so no link was made.')
      }
    }

    const node = nodeById(graphContext(), id)
    return joinLines([
      `Created ${node ? nodeRef(node) : id} — operator ${spec.id} "${spec.label}" (${spec.category}, ${spec.family})`,
      node ? `position ${Math.round(node.position.x)},${Math.round(node.position.y)}` : null,
      ...reports.map((report) => `  ${report}`),
      spec.inputs.length && !link
        ? `Not connected yet. Its inputs are: ${spec.inputs.map((port) => `${port.id} ("${port.label}", ${port.type})`).join(', ')}. Use connect_nodes.`
        : null,
      `New node id: ${id}`,
    ])
  },
}

const connectNodes: AgentTool = {
  name: 'connect_nodes',
  description:
    'Wire one operator into another. Texture outputs go to texture inputs; a signal (CHOP) output goes ' +
    'either to a numeric input or, with toParameter, to a modulatable parameter so it animates every ' +
    'frame. If toInput and toParameter are both omitted, the first free input of the matching type is ' +
    'used and the response says which one. Refusals quote the editor\'s own reason (occupied input, ' +
    'type mismatch, feedback loop).',
  readOnly: false,
  inputSchema: schema(
    {
      from: str(`Source node. ${NODE_REF}`),
      to: str(`Destination node. ${NODE_REF}`),
      toInput: str('Optional input port id ("in-0"), label ("Texture 1"), or index ("0").'),
      toParameter: str(`Optional parameter to drive instead of an input. ${PARAM_REF}`),
    },
    ['from', 'to'],
  ),
  execute: (args) =>
    connectCore(
      reqString(args, 'from', 'Pass the node the signal comes from.'),
      reqString(args, 'to', 'Pass the node the signal goes to.'),
      optString(args, 'toInput'),
      optString(args, 'toParameter'),
    ),
}

const disconnectTool: AgentTool = {
  name: 'disconnect',
  description:
    'Remove a link. Identify it by edgeId, or by the from/to pair (every link between them is removed), ' +
    'or by to plus toParameter to stop a signal driving that parameter. Do this before set_parameter on ' +
    'a parameter that is currently animated.',
  readOnly: false,
  inputSchema: schema({
    edgeId: str('Optional exact link id, as shown by inspect_graph.'),
    from: str(`Optional source node. ${NODE_REF}`),
    to: str(`Optional destination node. ${NODE_REF}`),
    toParameter: str(`Optional parameter on \`to\` whose signal link should be cut. ${PARAM_REF}`),
  }),
  execute: (args) => {
    const ctx = graphContext()
    const edgeId = optString(args, 'edgeId')
    const fromRef = optString(args, 'from')
    const toRef = optString(args, 'to')
    const paramRef = optString(args, 'toParameter')

    const targets: string[] = []
    if (edgeId) {
      const edge = ctx.edges.find((candidate) => candidate.id === edgeId)
      if (!edge) {
        fail(
          `No link with id "${edgeId}". Link ids change when the patch is reloaded; identify the link ` +
            'by from/to instead, or call inspect_graph for current ids.',
        )
      }
      targets.push(edge.id)
    } else if (toRef && paramRef) {
      const to = resolveNode(toRef, ctx)
      const param = resolveParamSpec(specOf(to), paramRef)
      const edge = driverEdge(ctx, to.id, param.key)
      if (!edge) {
        fail(
          `Nothing is driving ${nodeRef(to)}.${param.key}, so there is nothing to disconnect. ` +
            'Its value is already a fixed number you can change with set_parameter.',
        )
      }
      targets.push(edge.id)
    } else if (fromRef && toRef) {
      const from = resolveNode(fromRef, ctx)
      const to = resolveNode(toRef, ctx)
      const found = ctx.edges.filter((edge) => edge.source === from.id && edge.target === to.id)
      if (!found.length) {
        fail(
          `${nodeRef(from)} is not connected to ${nodeRef(to)}. Call trace_dependencies on either node ` +
            'to see the links that do exist.',
        )
      }
      targets.push(...found.map((edge) => edge.id))
    } else if (toRef) {
      const to = resolveNode(toRef, ctx)
      const found = edgesInto(ctx, to.id)
      if (!found.length) fail(`Nothing is connected into ${nodeRef(to)}.`)
      targets.push(...found.map((edge) => edge.id))
    } else {
      fail(
        'Nothing was identified. Pass edgeId, or from and to, or to and toParameter. Nothing was changed.',
      )
    }

    const described = targets.map((id) => {
      const edge = ctx.edges.find((candidate) => candidate.id === id)!
      const source = nodeById(ctx, edge.source)
      const target = nodeById(ctx, edge.target)
      const handle = edge.targetHandle ?? 'in'
      return `  ${source?.data.name ?? edge.source} → ${target?.data.name ?? edge.target}.${
        isParamHandle(handle) ? paramKeyFromHandle(handle) : handle
      }`
    })
    for (const id of targets) store().disconnect(id, AGENT_ACTOR)

    return joinLines([`Disconnected ${targets.length} link${targets.length === 1 ? '' : 's'}:`, ...described])
  },
}

const setParameter: AgentTool = {
  name: 'set_parameter',
  description:
    'Change one parameter on one node, live. Menu parameters accept the option name or its index; ' +
    'numbers are clamped to the parameter range; the response reports the value that actually landed. ' +
    'Refuses when the parameter is currently driven by a signal operator, because the signal would ' +
    'overwrite it next frame. Use set_parameters for several at once.',
  readOnly: false,
  inputSchema: schema(
    {
      nodeId: str(`The node to change. ${NODE_REF}`),
      parameter: str(PARAM_REF),
      value: {
        description:
          'New value. Number for float/int, true/false for bool, option name or index for menu, ' +
          'string for text, "#rrggbb" or [r,g,b,a] (0..1) for colour.',
      },
    },
    ['nodeId', 'parameter', 'value'],
  ),
  execute: (args) => {
    if (!('value' in args)) {
      fail('Missing required argument "value". Nothing was changed.')
    }
    return applyParameter(
      reqString(args, 'nodeId', 'Pass a node id or name.'),
      reqString(args, 'parameter', 'Pass a parameter key or label.'),
      args.value,
    )
  },
}

const setParameters: AgentTool = {
  name: 'set_parameters',
  description:
    'Change several parameters on one node in a single call — the right tool for an instruction like ' +
    '"make it more aggressive". Every parameter name is validated before anything is written, so a ' +
    'typo changes nothing.',
  readOnly: false,
  inputSchema: schema(
    {
      nodeId: str(`The node to change. ${NODE_REF}`),
      params: {
        type: 'object',
        description: 'Parameter key or label → new value. Same value rules as set_parameter.',
        additionalProperties: true,
      },
    },
    ['nodeId', 'params'],
  ),
  execute: (args) => {
    const ref = reqString(args, 'nodeId', 'Pass a node id or name.')
    const params = optRecord(args, 'params')
    if (!params || !Object.keys(params).length) {
      fail('Argument "params" was empty, so nothing was changed. Pass an object of parameter values.')
    }

    const ctx = graphContext()
    const node = resolveNode(ref, ctx)
    const spec = specOf(node)
    for (const key of Object.keys(params)) resolveParamSpec(spec, key)

    const reports = configure(node.id, params)
    return joinLines([
      `${nodeRef(node)} (${spec.label}) — ${reports.length} parameter${reports.length === 1 ? '' : 's'} applied:`,
      ...reports.map((report) => `  ${report}`),
    ])
  },
}

const deleteNode: AgentTool = {
  name: 'delete_node',
  description:
    'Delete one operator and every link touching it. Call trace_dependencies first if you are unsure ' +
    'what it feeds — deleting a node in the middle of a chain leaves the downstream operator unwired.',
  readOnly: false,
  inputSchema: schema({ node: str(`The node to delete. ${NODE_REF}`) }, ['node']),
  execute: (args) => deleteNodesCore([reqString(args, 'node', 'Pass a node id or name.')]),
}

const deleteNodesTool: AgentTool = {
  name: 'delete_nodes',
  description:
    'Delete several operators and all their links in one call, recorded as a single history entry.',
  readOnly: false,
  inputSchema: schema(
    { nodes: strings(`Node ids or names to delete. ${NODE_REF}`) },
    ['nodes'],
  ),
  execute: (args) => {
    const refs = optStringList(args, 'nodes')
    if (!refs?.length) fail('Argument "nodes" was empty, so nothing was deleted.')
    return deleteNodesCore(refs)
  },
}

function deleteNodesCore(refs: string[]): string {
  const ctx = graphContext()
  const nodes = resolveNodes(refs, ctx)
  const ids = new Set(nodes.map((node) => node.id))

  const orphaned = ctx.edges
    .filter((edge) => ids.has(edge.source) && !ids.has(edge.target))
    .map((edge) => {
      const target = nodeById(ctx, edge.target)
      const handle = edge.targetHandle ?? 'in'
      return `${target?.data.name ?? edge.target}.${isParamHandle(handle) ? paramKeyFromHandle(handle) : handle}`
    })
  const links = ctx.edges.filter((edge) => ids.has(edge.source) || ids.has(edge.target)).length

  store().deleteNodes([...ids], AGENT_ACTOR)

  return joinLines([
    `Deleted ${nodes.length} operator${nodes.length === 1 ? '' : 's'} and ${links} link${links === 1 ? '' : 's'}:`,
    ...nodes.map(
      (node) => `  ${nodeRef(node)} ${node.data.op}${changedParams(node, specOf(node)).length ? ` (had ${changedParams(node, specOf(node)).length} changed parameters)` : ''}`,
    ),
    orphaned.length
      ? `Now unwired downstream: ${shorten([...new Set(orphaned)].join(', '), 200)}. Rewire with connect_nodes or undo to restore.`
      : null,
    'Use undo, or revert_agent_changes, to bring them back.',
  ])
}

const insertEffect: AgentTool = {
  name: 'insert_effect',
  description:
    'Splice an operator into an existing texture link, so "add a VHS look to camera 1" needs no ' +
    'rewiring: the upstream link is broken, the new operator is placed between the two nodes, and both ' +
    'links are remade. Identify the link with after (the node the effect goes below), before (the node ' +
    'it goes above), both, or an exact edgeId.',
  readOnly: false,
  inputSchema: schema(
    {
      operator: str('Effect operator id from list_operators, e.g. "glitch", "bloom", "rgb-shift".'),
      after: str(`Optional. Insert directly downstream of this node. ${NODE_REF}`),
      before: str(`Optional. Insert directly upstream of this node. ${NODE_REF}`),
      edgeId: str('Optional exact link id from inspect_graph.'),
    },
    ['operator'],
  ),
  execute: (args) => {
    const ctx = graphContext()
    const spec = resolveOperator(reqString(args, 'operator', 'Pass an effect operator id.'))
    if (spec.family !== 'TOP' || !spec.inputs.some((port) => port.type === 'texture' && !port.delayed)) {
      fail(
        `${spec.label} cannot be inserted into a video link: it needs at least one plain texture input. ` +
          'Signal operators are wired with make_parameter_reactive or connect_nodes instead.',
      )
    }
    if (!spec.outputs.length) {
      fail(`${spec.label} is a terminal output operator, so nothing can be spliced through it.`)
    }

    const textureEdges = ctx.edges.filter((edge) => !isParamHandle(edge.targetHandle))
    const afterRef = optString(args, 'after')
    const beforeRef = optString(args, 'before')
    const edgeId = optString(args, 'edgeId')

    let candidates = textureEdges
    if (edgeId) {
      candidates = textureEdges.filter((edge) => edge.id === edgeId)
      if (!candidates.length) fail(`No texture link with id "${edgeId}". Call inspect_graph for current ids.`)
    } else {
      if (!afterRef && !beforeRef) {
        fail('Pass after, before, or edgeId so the link to splice is unambiguous. Nothing was changed.')
      }
      if (afterRef) {
        const after = resolveNode(afterRef, ctx)
        candidates = candidates.filter((edge) => edge.source === after.id)
        if (!candidates.length) {
          fail(
            `${nodeRef(after)} does not feed anything yet, so there is no link to splice. ` +
              `Use create_node with connectTo, or connect_nodes, to build the link first.`,
          )
        }
      }
      if (beforeRef) {
        const before = resolveNode(beforeRef, ctx)
        candidates = candidates.filter((edge) => edge.target === before.id)
        if (!candidates.length) {
          fail(
            `Nothing is connected into ${nodeRef(before)}${afterRef ? ` from "${afterRef}"` : ''}, ` +
              'so there is no link to splice.',
          )
        }
      }
    }

    if (candidates.length > 1) {
      fail(
        `That is ambiguous — ${candidates.length} links match: ${candidates
          .map((edge) => {
            const source = nodeById(ctx, edge.source)
            const target = nodeById(ctx, edge.target)
            return `${source?.data.name ?? edge.source} → ${target?.data.name ?? edge.target}.${edge.targetHandle} (edgeId ${edge.id})`
          })
          .join('; ')}. Pass both after and before, or an edgeId.`,
      )
    }

    const edge = candidates[0]
    const source = nodeById(ctx, edge.source)
    const target = nodeById(ctx, edge.target)
    const id = store().insertBetween(edge.id, spec.id, AGENT_ACTOR)
    if (!id) {
      fail(
        `The editor refused to insert ${spec.label} into that link. Nothing was changed. ` +
          'Check with inspect_graph that both ends still exist.',
      )
    }

    const node = nodeById(graphContext(), id)
    return joinLines([
      `Inserted ${node ? nodeRef(node) : id} (${spec.label}) between ${source ? nodeRef(source) : edge.source} and ${
        target ? nodeRef(target) : edge.target
      }.`,
      `${source?.data.name ?? '?'} → ${spec.label} → ${target?.data.name ?? '?'}.${edge.targetHandle ?? 'in'}`,
      `It starts at its defaults; set_parameters on ${id} to shape the look. New node id: ${id}`,
    ])
  },
}

const bypassNode: AgentTool = {
  name: 'bypass_node',
  description:
    'Bypass or un-bypass an operator. A bypassed filter passes its first input straight through, which ' +
    'is the safe way to A/B an effect without deleting it or losing its parameters.',
  readOnly: false,
  inputSchema: schema(
    {
      node: str(`The node to bypass. ${NODE_REF}`),
      bypass: boolean('true to bypass (default), false to bring the operator back into the chain.'),
    },
    ['node'],
  ),
  execute: (args) => setNodeFlag(reqString(args, 'node', 'Pass a node id or name.'), 'bypass', optBool(args, 'bypass') ?? true),
}

const enableNode: AgentTool = {
  name: 'enable_node',
  description:
    'Enable or disable an operator. A disabled operator outputs nothing at all, so everything ' +
    'downstream of it goes black — prefer bypass_node when you only want to skip an effect.',
  readOnly: false,
  inputSchema: schema(
    {
      node: str(`The node to change. ${NODE_REF}`),
      enabled: boolean('true to enable (default), false to disable.'),
    },
    ['node'],
  ),
  execute: (args) => setNodeFlag(reqString(args, 'node', 'Pass a node id or name.'), 'enabled', optBool(args, 'enabled') ?? true),
}

function setNodeFlag(ref: string, key: 'bypass' | 'enabled', value: boolean): string {
  const ctx = graphContext()
  const node = resolveNode(ref, ctx)
  const spec = specOf(node)

  if (node.data[key] === value) {
    return `${nodeRef(node)} is already ${key === 'bypass' ? (value ? 'bypassed' : 'not bypassed') : value ? 'enabled' : 'disabled'}. Nothing was changed.`
  }
  if (key === 'bypass' && value && !spec.inputs.length) {
    fail(
      `${nodeRef(node)} (${spec.label}) has no input, so bypassing it would produce nothing rather than ` +
        'passing a signal through. Use enable_node with enabled=false if you want to switch it off.',
    )
  }

  store().setField(node.id, key, value, AGENT_ACTOR)
  const downstream = edgesOutOf(ctx, node.id)
    .map((edge) => nodeById(ctx, edge.target)?.data.name ?? edge.target)
    .join(', ')
  return joinLines([
    `${nodeRef(node)} ${key === 'bypass' ? (value ? 'bypassed — its first input now passes straight through' : 'back in the chain') : value ? 'enabled' : 'disabled — it now outputs nothing'}.`,
    downstream ? `Affects downstream: ${downstream}.` : 'Nothing is downstream, so nothing on screen changes.',
  ])
}

const routeSourceToOutput: AgentTool = {
  name: 'route_source_to_output',
  description:
    'Build or repair a whole video chain in one call: source → optional effects → output. Any operator ' +
    'that does not exist yet is created (so source="camera" makes a Camera node if there is none), ' +
    'links that point somewhere else are replaced, and links that are already correct are left alone. ' +
    'This is the tool for "send the clean camera to the stream output" or "put a glitch and a bloom ' +
    'between the camera and the program out".',
  readOnly: false,
  inputSchema: schema(
    {
      source: str(
        `The start of the chain: an existing node (${NODE_REF}) or an operator id such as "camera", ` +
          '"remote-in", "video", "noise-top".',
      ),
      output: str(
        'The end of the chain: an existing output node, or an operator id ("out" for the program ' +
          'monitor, "remote-out" for a projector/stream link). Defaults to "out".',
      ),
      effects: strings(
        'Optional operators to pass through, in order. An operator id creates a new node ' +
          '("glitch"); an existing node id reuses that node ("glitch-1").',
      ),
    },
    ['source'],
  ),
  execute: (args) => {
    const sourceRef = reqString(args, 'source', 'Pass a node or an operator id such as "camera".')
    const outputRef = optString(args, 'output') ?? 'out'
    const effectRefs = optStringList(args, 'effects') ?? []

    const created: string[] = []
    const source = ensureNode(sourceRef)
    if (source.created) created.push(nodeRef(source.node))

    const sourceSpec = specOf(source.node)
    if (!sourceSpec.outputs.length) {
      fail(`${nodeRef(source.node)} is a terminal operator and cannot start a chain.`)
    }

    const base = source.node.position
    const chain: PatchNode[] = [source.node]

    effectRefs.forEach((ref, index) => {
      const position = { x: base.x + 280 * (index + 1), y: base.y }
      // An operator id always makes a fresh effect; a node id reuses that node.
      const entry = ensureNode(ref, position)
      if (entry.created) created.push(nodeRef(entry.node))
      chain.push(entry.node)
    })

    const output = ensureNode(outputRef, {
      x: base.x + 280 * (effectRefs.length + 1),
      y: base.y,
    })
    if (output.created) created.push(nodeRef(output.node))
    if (specOf(output.node).runtime !== 'output') {
      fail(
        `${nodeRef(output.node)} (${specOf(output.node).label}) is not an output operator, so the chain ` +
          'would not reach a screen. Pass output="out" for the program monitor or "remote-out" for a ' +
          'projector link, or the id of an existing output node.',
      )
    }
    chain.push(output.node)

    const reports = wireChain(chain)

    const after = graphContext()
    const feeding = after.plan.nodes.get(output.node.id)?.inputs[0] ?? null
    return joinLines([
      `Routed ${chain.map((node) => node.data.name).join(' → ')}`,
      created.length ? `Created: ${created.join(', ')}` : 'Created nothing — every operator already existed.',
      ...reports.map((report) => `  ${report}`),
      `Chain now feeding ${nodeRef(output.node)}: ${shorten(textureChain(after, output.node.id), 200)}`,
      feeding
        ? engine.getStatus().state === 'running'
          ? engine.hasTexture(feeding)
            ? 'The output has a live signal.'
            : 'The output is wired but produced no texture last frame — check the source has media (inspect_source).'
          : 'The output is wired; the render engine is not running, so nothing is on screen yet.'
        : 'WARNING: the output still has no input. Call inspect_output for why.',
      ...after.plan.issues
        .filter((issue) => issue.severity === 'error')
        .slice(0, 4)
        .map((issue) => `  ERROR ${issue.message}`),
    ])
  },
}

type ReactiveSource = 'bass' | 'mid' | 'treble' | 'level' | 'beat' | 'lfo'

const REACTIVE: Record<
  ReactiveSource,
  { op: string; params: Record<string, unknown>; what: string; unipolar: boolean; audio: boolean }
> = {
  bass: {
    op: 'audio-band',
    params: { band: 'Bass', gain: 2, smoothing: 0.05, normalize: true },
    what: 'energy in the 20–140 Hz bass band',
    unipolar: true,
    audio: true,
  },
  mid: {
    op: 'audio-band',
    params: { band: 'Mid', gain: 2, smoothing: 0.06, normalize: true },
    what: 'energy in the 400–2000 Hz mid band',
    unipolar: true,
    audio: true,
  },
  treble: {
    op: 'audio-band',
    params: { band: 'Treble', gain: 2, smoothing: 0.05, normalize: true },
    what: 'energy in the 6–16 kHz treble band',
    unipolar: true,
    audio: true,
  },
  level: {
    op: 'audio-in',
    params: { measure: 'RMS', gain: 1.5, smoothing: 0.08 },
    what: 'overall loudness of the audio input',
    unipolar: true,
    audio: true,
  },
  beat: {
    op: 'beat',
    params: { output: 'Envelope', decay: 0.22, sensitivity: 1 },
    what: 'an envelope that snaps to 1 on every detected onset and decays over 0.22 s',
    unipolar: true,
    audio: true,
  },
  lfo: {
    op: 'lfo',
    params: { shape: 'Sine', frequency: 0.25 },
    what: 'a 0.25 Hz sine oscillator',
    unipolar: false,
    audio: false,
  },
}

const makeParameterReactive: AgentTool = {
  name: 'make_parameter_reactive',
  description:
    'Animate a parameter from the music (or from an oscillator) in one call. Creates the right signal ' +
    'operator — Audio Band for bass/mid/treble, Audio In for level, Beat for onsets, LFO for a steady ' +
    'sweep — places it near the target, wires it to the parameter, and shapes its output range so the ' +
    'movement is actually visible. Add a Range operator when the parameter does not live in 0..1. ' +
    'Use amount, or explicit low/high, to control how far it swings.',
  readOnly: false,
  inputSchema: schema(
    {
      nodeId: str(`The node whose parameter should move. ${NODE_REF}`),
      parameter: str(`The parameter to animate. ${PARAM_REF} It must be modulatable.`),
      source: str(
        'What drives it: "bass", "mid", "treble" (frequency bands), "level" (overall loudness), ' +
          '"beat" (onset envelope), or "lfo" (steady oscillator).',
      ),
      amount: number(
        'Optional 0..1, default 0.75: the fraction of the parameter\'s full range the movement covers. ' +
          'Ignored when low and high are given.',
      ),
      low: number('Optional. Exact value the parameter takes when the signal is at its minimum.'),
      high: number('Optional. Exact value the parameter takes when the signal peaks.'),
      replace: boolean(
        'Optional. Set true to replace a signal that already drives this parameter. Defaults to false, ' +
          'which refuses rather than silently rewiring.',
      ),
    },
    ['nodeId', 'parameter', 'source'],
  ),
  execute: (args) => {
    const ctx = graphContext()
    const node = resolveNode(reqString(args, 'nodeId', 'Pass a node id or name.'), ctx)
    const spec = specOf(node)
    const param = resolveParamSpec(spec, reqString(args, 'parameter', 'Pass a parameter key or label.'))
    const sourceKey = reqString(args, 'source', 'One of: bass, mid, treble, level, beat, lfo.').toLowerCase()

    const recipe = REACTIVE[sourceKey as ReactiveSource]
    if (!recipe) {
      fail(
        `"${sourceKey}" is not a signal source. Use one of: ${Object.keys(REACTIVE).join(', ')}. ` +
          'For a MIDI knob or the mouse, create a midi-in or pointer operator with create_node and wire ' +
          'it with connect_nodes.',
      )
    }

    if (!param.modulatable) {
      fail(
        `${spec.label}.${param.key} cannot be driven by a signal (kind ${param.kind}${param.system ? ', engine-written' : ''}). ` +
          `Modulatable parameters on ${spec.label}: ${spec.params
            .filter((entry) => entry.modulatable)
            .map((entry) => entry.key)
            .join(', ') || 'none'}.`,
      )
    }

    const existing = driverEdge(ctx, node.id, param.key)
    const replace = optBool(args, 'replace') ?? false
    if (existing && !replace) {
      const driver = nodeById(ctx, existing.source)
      fail(
        `${nodeRef(node)}.${param.key} is already driven by ${driver ? nodeRef(driver) : existing.source}. ` +
          'Nothing was changed. Pass replace=true to swap it, change that signal operator\'s parameters ' +
          `instead, or call disconnect with to="${node.id}" toParameter="${param.key}".`,
      )
    }

    // Range shaping. A driven parameter is *replaced* by the signal value each
    // frame, so the signal must land inside the parameter's own range.
    const min = param.kind === 'bool' ? 0 : (param.min ?? 0)
    const max = param.kind === 'bool' ? 1 : (param.max ?? 1)
    const span = max - min || 1
    const amount = Math.min(1, Math.max(0.05, optNumber(args, 'amount') ?? 0.75))
    let low = optNumber(args, 'low')
    let high = optNumber(args, 'high')

    if (low === undefined || high === undefined) {
      if (recipe.unipolar) {
        low = min
        high = min + span * amount
      } else {
        const current = Number(resolveParams(node)[param.key])
        const centre = Number.isFinite(current) ? Math.min(max, Math.max(min, current)) : min + span / 2
        const half = (span * amount) / 2
        low = Math.max(min, centre - half)
        high = Math.min(max, centre + half)
        if (high - low < span * 0.1) {
          low = min
          high = min + span * amount
        }
      }
    }
    if (low === high) high = low + span * 0.25
    const rounded = (value: number) => Math.round(value * 1000) / 1000
    low = rounded(low)
    high = rounded(high)

    if (existing) store().disconnect(existing.id, AGENT_ACTOR)

    const needsRange = recipe.op !== 'lfo' && (low !== 0 || high !== 1)
    const driverPosition = { x: node.position.x - (needsRange ? 620 : 320), y: node.position.y + 240 }

    const driverId = store().addOperator(recipe.op, driverPosition, AGENT_ACTOR)
    const driverParams: Record<string, unknown> = { ...recipe.params }
    if (recipe.op === 'lfo') {
      driverParams.amplitude = rounded((high - low) / 2)
      driverParams.offset = rounded((high + low) / 2)
    }
    const configured = configureCompact(driverId, driverParams)

    let rangeId: string | null = null
    if (needsRange) {
      rangeId = store().addOperator(
        'range',
        { x: node.position.x - 320, y: node.position.y + 240 },
        AGENT_ACTOR,
      )
      configureCompact(rangeId, { fromLow: 0, fromHigh: 1, toLow: low, toHigh: high, clamp: true })
    }

    const wiring: string[] = []
    if (rangeId) {
      wiring.push(connectCore(driverId, rangeId))
      wiring.push(connectCore(rangeId, node.id, undefined, param.key))
    } else {
      wiring.push(connectCore(driverId, node.id, undefined, param.key))
    }

    const after = graphContext()
    const driverNode = nodeById(after, driverId)
    const rangeNode = rangeId ? nodeById(after, rangeId) : undefined

    return joinLines([
      `${nodeRef(node)}.${param.key} ("${param.label}") now reacts to ${sourceKey.toUpperCase()}.`,
      `Built: ${driverNode ? nodeRef(driverNode) : driverId} — ${recipe.what}` +
        (rangeNode ? ` → ${nodeRef(rangeNode)} (0..1 remapped to ${low}..${high})` : '') +
        ` → ${node.data.name}.${param.key}`,
      `Sweep: ${param.label} moves between ${low} and ${high} (its full range is ${min}..${max}${param.unit ? ` ${param.unit}` : ''}).`,
      configured ? `Signal settings: ${configured}` : null,
      ...wiring.map((line) => `  ${line}`),
      existing ? 'Replaced the signal that was previously driving this parameter.' : null,
      recipe.audio && audioEngine.state !== 'running'
        ? `NOTE: audio input is "${audioEngine.state}", so this signal reads 0 until the microphone is started ` +
          '(the user enables it from the toolbar). Everything is wired and will move as soon as it is.'
        : null,
      'Verify with read_signals, and set_parameters on the signal operator to tune gain/smoothing.',
    ])
  },
}

const revertAgentChanges: AgentTool = {
  name: 'revert_agent_changes',
  description:
    'Undo everything the agent changed recently, leaving edits made by the human operator in place. ' +
    'Use this when the user says "put it back how it was" after you have made several changes; use undo ' +
    'for a single step regardless of who made it.',
  readOnly: false,
  inputSchema: schema({
    sinceSeconds: number('How far back to reverse, in seconds. Default 120.'),
  }),
  execute: (args) => {
    const seconds = Math.max(1, optNumber(args, 'sinceSeconds') ?? 120)
    const cutoff = Date.now() - seconds * 1000
    // The store leaves reverted records in `history` (a revert is itself a new
    // entry rather than a flag on the old ones), so without this bookkeeping a
    // second call would "revert" the same changes again and report work it did
    // not do.
    const matches = (record: { id: string; at: number; actor: { kind: string }; kind: string }) =>
      record.actor.kind === 'agent' &&
      record.kind !== 'revert' &&
      record.at >= cutoff &&
      !revertedRecordIds.has(record.id)

    const log = store().changeLog.length ? store().changeLog : store().history
    const doomed = log.filter(matches)
    if (!doomed.length) {
      const everything = log.filter((record) => record.actor.kind === 'agent').length
      return (
        `Nothing to revert: no agent change in the last ${seconds}s that has not already been reverted ` +
        `(the undo stack holds ${everything} agent entr${everything === 1 ? 'y' : 'ies'} in total). ` +
        'Call get_recent_changes with actorKind="agent" to see them, or undo for the last change by anyone.'
      )
    }

    const labels = doomed
      .slice()
      .reverse()
      .map((record) => `  ${relativeTime(record.at)}  ${shorten(record.label, 90)}`)
    const count = store().revertChanges(matches, `Reverted ${doomed.length} agent changes (last ${seconds}s)`)
    for (const record of doomed) revertedRecordIds.add(record.id)

    return joinLines([
      `Reversed ${count} agent change${count === 1 ? '' : 's'} from the last ${seconds}s, newest first:`,
      ...capLines(labels, 12, 'The rest were reverted too.'),
      'Human edits were left untouched. The reversal is itself one history entry, so undo restores them.',
    ])
  },
}

/** Change records this tool surface has already reversed. See revert_agent_changes. */
const revertedRecordIds = new Set<string>()

const undoTool: AgentTool = {
  name: 'undo',
  description:
    'Undo the most recent change, whoever made it. Prefer revert_agent_changes when you specifically ' +
    'want to take back your own edits.',
  readOnly: false,
  inputSchema: schema({}),
  execute: () => {
    const record = store().history.at(-1)
    if (!record) return 'The undo stack is empty, so nothing was undone.'
    store().undo()
    return `Undid "${record.label}" (${record.actor.name}, ${relativeTime(record.at)}). Call redo to put it back.`
  },
}

const redoTool: AgentTool = {
  name: 'redo',
  description: 'Redo the change that was most recently undone.',
  readOnly: false,
  inputSchema: schema({}),
  execute: () => {
    const record = store().undone[0]
    if (!record) return 'There is nothing to redo (the redo stack is empty).'
    store().redo()
    return `Redid "${record.label}" (originally by ${record.actor.name}).`
  },
}

// -------------------------------------------------------------- the surface ----

export const agentTools: AgentTool[] = [
  // Inspection first: an agent reading the list top-down learns to look before
  // it touches anything.
  inspectGraph,
  listOperators,
  describeOperator,
  getMediaTopology,
  inspectSource,
  inspectOutput,
  traceDependencies,
  getSystemHealth,
  getRecentChanges,
  readSignals,
  // Operation.
  createNodeTool,
  connectNodes,
  disconnectTool,
  setParameter,
  setParameters,
  deleteNode,
  deleteNodesTool,
  insertEffect,
  bypassNode,
  enableNode,
  routeSourceToOutput,
  makeParameterReactive,
  revertAgentChanges,
  undoTool,
  redoTool,
]
