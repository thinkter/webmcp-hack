/**
 * WebMCP registration.
 *
 * The browser API is still moving, so this file assumes as little as possible:
 *
 *  - the context object may hang off `document.modelContext` (the shape used by
 *    the Chrome prototype and the current explainer) or `navigator.modelContext`
 *    (used by some builds and by the polyfill); whichever exists is used;
 *  - tools may be provided declaratively in one call, `provideContext({ tools })`,
 *    or one at a time with `registerTool(tool)`. Both spellings are implemented
 *    here behind one adapter, and either may return a promise or nothing;
 *  - unregistration may be `unregisterTool(name)`, an `AbortSignal` passed at
 *    registration time, or a disposer returned from the call. All three are
 *    handled, and the whole-set spelling is torn down by re-providing an empty
 *    tool list.
 *
 * If none of that is present the editor must behave exactly as it does today,
 * so `registerAgentTools()` reports `supported: false` and never throws.
 */

import { ToolError } from './describe'
import { agentTools, type AgentTool } from './tools'

// ------------------------------------------------------------- the API shape ----

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

type ToolDescriptor = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

type Unsubscribe = (() => void) | { dispose?: () => void } | void

type ModelContextLike = {
  /** Declarative form: replaces the whole tool set. */
  provideContext?: (payload: { tools: ToolDescriptor[] }) => unknown
  /** Imperative form: one tool at a time. */
  registerTool?: (tool: ToolDescriptor, options?: { signal?: AbortSignal }) => Unsubscribe | Promise<Unsubscribe>
  unregisterTool?: (name: string) => unknown
}

declare global {
  interface Document {
    modelContext?: ModelContextLike
  }
  interface Navigator {
    modelContext?: ModelContextLike
  }
}

export type AgentRegistration = {
  toolCount: number
  supported: boolean
  dispose: () => void
}

const noop = (): void => undefined

// ------------------------------------------------------------------ results ----

const textResult = (text: string, isError = false): ToolResult =>
  isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }

/**
 * The shared handler. Agents recover from good errors and flounder on bad ones,
 * so a failure always names the tool, says what was wrong, and suggests the next
 * call. `ToolError` messages are written for the agent; anything else is a bug in
 * this app and is reported as such rather than being dressed up as user error.
 */
async function runTool(tool: AgentTool, rawArgs: unknown): Promise<ToolResult> {
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {}

  try {
    const text = await tool.execute(args)
    return textResult(text.length ? text : `${tool.name} produced no output.`)
  } catch (cause) {
    if (cause instanceof ToolError) {
      return textResult(`${tool.name} failed: ${cause.message}`, true)
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(`[webmcp] ${tool.name} threw`, cause)
    return textResult(
      `${tool.name} hit an unexpected error in the editor: ${message}. ` +
        'The patch may be unchanged. Call inspect_graph to see the current state before retrying, ' +
        'and get_system_health if the render engine looks wrong.',
      true,
    )
  }
}

const toDescriptor = (tool: AgentTool): ToolDescriptor => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { readOnlyHint: tool.readOnly },
  execute: (args) => runTool(tool, args),
})

// ------------------------------------------------------------- registration ----

function findContext(): ModelContextLike | null {
  // `document` first: that is where the shipping prototype puts it. `navigator`
  // is checked second because some builds and the polyfill expose it there.
  const candidates: Array<ModelContextLike | undefined> = [
    typeof document === 'undefined' ? undefined : document.modelContext,
    typeof navigator === 'undefined' ? undefined : navigator.modelContext,
  ]
  for (const candidate of candidates) {
    if (candidate && (candidate.provideContext || candidate.registerTool)) return candidate
  }
  return null
}

export function registerAgentTools(): AgentRegistration {
  const context = findContext()
  if (!context) {
    // No WebMCP in this browser. The editor is fully usable without it.
    return { toolCount: 0, supported: false, dispose: noop }
  }

  const descriptors = agentTools.map(toDescriptor)

  try {
    if (typeof context.provideContext === 'function') {
      context.provideContext({ tools: descriptors })
      return {
        toolCount: descriptors.length,
        supported: true,
        dispose: () => {
          try {
            // The declarative form is a whole-set replacement, so an empty list
            // is how a set is withdrawn.
            context.provideContext?.({ tools: [] })
          } catch (cause) {
            console.warn('[webmcp] could not withdraw tools', cause)
          }
        },
      }
    }

    const register = context.registerTool
    if (typeof register === 'function') {
      const controller = new AbortController()
      const disposers: Array<() => void> = []

      for (const descriptor of descriptors) {
        const returned = register.call(context, descriptor, { signal: controller.signal })
        // The call may be sync, may return a disposer, or may return a promise
        // of one. Collect whatever comes back without depending on which.
        void Promise.resolve(returned)
          .then((value) => {
            if (typeof value === 'function') disposers.push(value)
            else if (value && typeof value.dispose === 'function') disposers.push(() => value.dispose?.())
          })
          .catch((cause: unknown) => {
            console.error(`[webmcp] registering ${descriptor.name} failed`, cause)
          })
      }

      return {
        toolCount: descriptors.length,
        supported: true,
        dispose: () => {
          controller.abort()
          for (const disposer of disposers) {
            try {
              disposer()
            } catch (cause) {
              console.warn('[webmcp] tool disposer threw', cause)
            }
          }
          if (typeof context.unregisterTool === 'function') {
            for (const descriptor of descriptors) {
              try {
                context.unregisterTool(descriptor.name)
              } catch (cause) {
                console.warn(`[webmcp] could not unregister ${descriptor.name}`, cause)
              }
            }
          }
        },
      }
    }
  } catch (cause) {
    // A hostile or half-implemented API must not take the editor down with it.
    console.error('[webmcp] tool registration failed', cause)
    return { toolCount: 0, supported: false, dispose: noop }
  }

  return { toolCount: 0, supported: false, dispose: noop }
}
