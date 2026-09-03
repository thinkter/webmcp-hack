/**
 * Turns the editable patch into an execution plan.
 *
 * This is where the semantics live: what "bypass" means, what a disabled node
 * outputs, how a feedback loop is legal, and what happens when a link is
 * missing. The renderer itself is then a fairly dumb walk over the plan, and
 * both the monitor and the WebMCP diagnostics read the same issue list, so what
 * an agent is told matches what a user sees.
 */

import { getOperator } from './ops'
import type { OperatorSpec } from './ops/kit'
import { isParamHandle, paramKeyFromHandle, type PatchEdge, type PatchNode } from '../graph/types'

export type PlanIssue = {
  nodeId?: string
  severity: 'error' | 'warning' | 'info'
  message: string
}

export type PlanNode = {
  id: string
  op: string
  name: string
  spec: OperatorSpec
  /**
   * Resolved source node per texture input, after following bypassed operators.
   * `null` means the input is unwired or upstream produces no signal.
   */
  inputs: Array<string | null>
  /** True for inputs read from the previous frame. */
  delayed: boolean[]
  /** Parameter key to the CHOP node driving it. */
  modulations: Map<string, string>
  bypassed: boolean
  disabled: boolean
}

export type Plan = {
  /** Texture operators in a safe execution order. */
  order: string[]
  /** Signal operators in a safe evaluation order. */
  chopOrder: string[]
  nodes: Map<string, PlanNode>
  /** Non-delayed texture dependencies, used for ordering and lifetimes. */
  dependencies: Map<string, string[]>
  /** Delayed dependencies, resolved at end of frame for feedback copies. */
  delayedDependencies: Map<string, string[]>
  outputs: string[]
  feedbacks: string[]
  issues: PlanIssue[]
  /** Stable signature; identical plans can reuse cached GPU resources. */
  signature: string
}

export function buildPlan(nodes: PatchNode[], edges: PatchEdge[]): Plan {
  const issues: PlanIssue[] = []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const specs = new Map<string, OperatorSpec>()

  for (const node of nodes) {
    const spec = getOperator(node.data.op)
    if (!spec) {
      issues.push({
        nodeId: node.id,
        severity: 'error',
        message: `"${node.data.op}" is not an operator this build knows about.`,
      })
      continue
    }
    specs.set(node.id, spec)
  }

  // Index incoming edges by target node and handle.
  const incoming = new Map<string, Map<string, PatchEdge>>()
  for (const edge of edges) {
    if (!edge.targetHandle) continue
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    let handles = incoming.get(edge.target)
    if (!handles) {
      handles = new Map()
      incoming.set(edge.target, handles)
    }
    if (handles.has(edge.targetHandle)) {
      issues.push({
        nodeId: edge.target,
        severity: 'warning',
        message: 'Two links target the same input; only the first is used.',
      })
      continue
    }
    handles.set(edge.targetHandle, edge)
  }

  /**
   * Follows bypass and disabled state to find the node that actually supplies
   * pixels. A bypassed filter is transparent, so downstream reads whatever fed
   * its first input; a disabled node supplies nothing at all.
   */
  const resolveCache = new Map<string, string | null>()
  function resolveSource(nodeId: string, guard = new Set<string>()): string | null {
    if (resolveCache.has(nodeId)) return resolveCache.get(nodeId)!
    if (guard.has(nodeId)) return null
    guard.add(nodeId)

    const node = byId.get(nodeId)
    const spec = specs.get(nodeId)
    if (!node || !spec) {
      resolveCache.set(nodeId, null)
      return null
    }

    let result: string | null = nodeId
    if (!node.data.enabled) {
      result = null
    } else if (node.data.bypass && spec.inputs.length) {
      const upstream = incoming.get(nodeId)?.get(spec.inputs[0].id)
      result = upstream ? resolveSource(upstream.source, guard) : null
    }

    resolveCache.set(nodeId, result)
    return result
  }

  const planNodes = new Map<string, PlanNode>()
  const dependencies = new Map<string, string[]>()
  const delayedDependencies = new Map<string, string[]>()
  const outputs: string[] = []
  const feedbacks: string[] = []
  const chopNodes: string[] = []

  for (const node of nodes) {
    const spec = specs.get(node.id)
    if (!spec) continue

    const modulations = new Map<string, string>()
    const handles = incoming.get(node.id)
    if (handles) {
      for (const [handle, edge] of handles) {
        if (!isParamHandle(handle)) continue
        const key = paramKeyFromHandle(handle)
        const param = spec.params.find((candidate) => candidate.key === key)
        if (!param?.modulatable) {
          issues.push({
            nodeId: node.id,
            severity: 'warning',
            message: `"${key}" cannot be driven by a signal; that link is ignored.`,
          })
          continue
        }
        const sourceSpec = specs.get(edge.source)
        if (sourceSpec?.family !== 'CHOP') {
          issues.push({
            nodeId: node.id,
            severity: 'warning',
            message: `Only signal operators can drive "${key}".`,
          })
          continue
        }
        modulations.set(key, edge.source)
      }
    }

    if (spec.family === 'CHOP') {
      chopNodes.push(node.id)
      planNodes.set(node.id, {
        id: node.id,
        op: node.data.op,
        name: node.data.name,
        spec,
        inputs: spec.inputs.map((port) => {
          const edge = handles?.get(port.id)
          return edge ? edge.source : null
        }),
        delayed: spec.inputs.map(() => false),
        modulations,
        bypassed: false,
        disabled: !node.data.enabled,
      })
      continue
    }

    const inputs: Array<string | null> = []
    const delayed: boolean[] = []
    const deps: string[] = []
    const delayedDeps: string[] = []

    for (const port of spec.inputs) {
      const edge = handles?.get(port.id)
      if (!edge) {
        inputs.push(null)
        delayed.push(port.delayed ?? false)
        if (!port.optional && !port.delayed && spec.inputs.indexOf(port) === 0) {
          // Only the first input is worth complaining about; secondary inputs of
          // composite operators are legitimately optional.
          if (spec.runtime !== 'external' && spec.runtime !== 'raster') {
            issues.push({
              nodeId: node.id,
              severity: spec.runtime === 'output' ? 'error' : 'warning',
              message: `${node.data.name} has nothing connected to "${port.label}".`,
            })
          }
        }
        continue
      }

      const resolved = resolveSource(edge.source)
      inputs.push(resolved)
      delayed.push(port.delayed ?? false)
      if (resolved) {
        if (port.delayed) delayedDeps.push(resolved)
        else deps.push(resolved)
      }
    }

    planNodes.set(node.id, {
      id: node.id,
      op: node.data.op,
      name: node.data.name,
      spec,
      inputs,
      delayed,
      modulations,
      bypassed: node.data.bypass,
      disabled: !node.data.enabled,
    })

    dependencies.set(node.id, deps)
    delayedDependencies.set(node.id, delayedDeps)

    if (spec.runtime === 'output') outputs.push(node.id)
    if (spec.runtime === 'delay') feedbacks.push(node.id)
  }

  // Signal operators also need ordering, since Math and Lag chain together.
  const chopOrder = topoSort(
    chopNodes,
    (id) => (planNodes.get(id)?.inputs.filter((input): input is string => input !== null) ?? []),
    (cycle) =>
      issues.push({
        nodeId: cycle[0],
        severity: 'error',
        message: `Signal operators form a loop (${cycle.map((id) => byId.get(id)?.data.name ?? id).join(' → ')}). The loop is not evaluated.`,
      }),
  )

  const topIds = [...planNodes.keys()].filter((id) => planNodes.get(id)!.spec.family === 'TOP')
  const order = topoSort(
    topIds,
    (id) => dependencies.get(id) ?? [],
    (cycle) =>
      issues.push({
        nodeId: cycle[0],
        severity: 'error',
        message: `Texture path contains a loop (${cycle.map((id) => byId.get(id)?.data.name ?? id).join(' → ')}). Insert a Feedback operator to break it.`,
      }),
  )

  if (!outputs.length) {
    issues.push({
      severity: 'error',
      message: 'This patch has no Out operator, so nothing can reach the monitor.',
    })
  }

  return {
    order,
    chopOrder,
    nodes: planNodes,
    dependencies,
    delayedDependencies,
    outputs,
    feedbacks,
    issues,
    signature: signatureOf(nodes, edges),
  }
}

/**
 * Kahn's algorithm. Nodes left over after the queue drains are in a cycle; they
 * are reported and appended so the rest of the graph still runs — a broken
 * corner of a patch should not black out the whole show.
 */
function topoSort(
  ids: string[],
  dependenciesOf: (id: string) => string[],
  onCycle: (cycle: string[]) => void,
): string[] {
  const present = new Set(ids)
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const id of ids) indegree.set(id, 0)
  for (const id of ids) {
    for (const dependency of dependenciesOf(id)) {
      if (!present.has(dependency)) continue
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
      const list = dependents.get(dependency)
      if (list) list.push(id)
      else dependents.set(dependency, [id])
    }
  }

  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 1) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) queue.push(dependent)
    }
  }

  if (order.length !== ids.length) {
    const stuck = ids.filter((id) => !order.includes(id))
    onCycle(stuck)
    order.push(...stuck)
  }

  return order
}

/** Signature covering everything that affects execution structure. */
function signatureOf(nodes: PatchNode[], edges: PatchEdge[]): string {
  const nodePart = nodes
    .map((node) => `${node.id}:${node.data.op}:${node.data.enabled ? 1 : 0}${node.data.bypass ? 1 : 0}`)
    .sort()
    .join(',')
  const edgePart = edges
    .map((edge) => `${edge.source}>${edge.target}#${edge.targetHandle ?? ''}`)
    .sort()
    .join(',')
  return `${nodePart}|${edgePart}`
}

/** Node ids whose textures are needed to produce the given roots. */
export function ancestorsOf(plan: Plan, roots: Iterable<string>): Set<string> {
  const needed = new Set<string>()
  const stack = [...roots]
  while (stack.length) {
    const id = stack.pop()!
    if (needed.has(id)) continue
    needed.add(id)
    for (const dependency of plan.dependencies.get(id) ?? []) stack.push(dependency)
    // A feedback node's delayed source must also be rendered, otherwise there
    // is nothing to copy into its history at end of frame.
    for (const dependency of plan.delayedDependencies.get(id) ?? []) stack.push(dependency)
  }
  return needed
}
