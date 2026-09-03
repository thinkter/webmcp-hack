/**
 * WebMCP registration.
 *
 * Implements the W3C Web Machine Learning Community Group's WebMCP specification
 * (webmachinelearning.github.io/webmcp) for exposing in-browser tools on `document.modelContext`.
 *
 * Features:
 *  - Native detection: Uses the browser's native `document.modelContext` when available
 *    (Chrome with `--enable-features=WebMCP` or origin-trial token, ChatGPT in-app browser).
 *  - Spec polyfill fallback: In browsers without native support, initializes the spec-pure
 *    `@mcp-b/webmcp-polyfill` so tools can be discovered and executed in every environment.
 *  - Standard lifecycle: Uses `document.modelContext.registerTool(tool, { signal })` with
 *    an AbortSignal for deterministic unregistration on teardown.
 *  - Resilient execution: `execute` handles both parsed objects and serialized JSON arguments,
 *    supports abort signals, and returns structured MCP responses `{ content, text, isError }`.
 *  - Dev ergonomics: Exposes `window.webmcp` and enhances `executeTool` to accept either
 *    tool objects or tool names with string/object parameters.
 */

import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'
import type { RegisteredTool } from '@mcp-b/webmcp-types'
import { ToolError } from './describe'
import { agentTools, type AgentTool } from './tools'

// ------------------------------------------------------------- types ----

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  text: string
  isError?: boolean
  toString(): string
}

export type AgentRegistration = {
  toolCount: number
  supported: boolean
  isNative: boolean
  dispose: () => void
}

const noop = (): void => undefined

let nativeDetected = false

/**
 * Initializes WebMCP support.
 * If the browser already provides native `document.modelContext`, leaves it untouched.
 * Otherwise, initializes the standard polyfill.
 */
export function ensureWebMCPInitialized(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  if ('modelContext' in document && document.modelContext) {
    nativeDetected = true
    return
  }

  try {
    initializeWebMCPPolyfill({ installTestingShim: true })
  } catch (cause) {
    console.warn('[webmcp] polyfill initialization warning:', cause)
  }
}

// Initialize on module load when running in a browser
ensureWebMCPInitialized()

// ------------------------------------------------------------------ results ----

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text }],
  text,
  isError,
  toString() {
    return text
  },
})

/**
 * The shared handler. Agents recover from good errors and flounder on bad ones,
 * so a failure always names the tool, says what was wrong, and suggests the next
 * call. `ToolError` messages are written for the agent; anything else is a bug in
 * this app and is reported as such rather than being dressed up as user error.
 */
async function runTool(
  tool: AgentTool,
  rawArgs: unknown,
  options?: { signal?: AbortSignal },
): Promise<ToolResult> {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? new Error('Tool execution was cancelled.')
  }

  let args: Record<string, unknown> = {}
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>
      }
    } catch {
      args = {}
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>
  }

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

const toDescriptor = (tool: AgentTool) => ({
  name: tool.name,
  title: tool.name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' '),
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: {
    readOnlyHint: tool.readOnly,
    untrustedContentHint: false,
  },
  execute: (args: unknown, options?: { signal?: AbortSignal }) => runTool(tool, args, options),
})

// ------------------------------------------------------------- context lookup ----

type ModelContextHost = {
  modelContext?: unknown
}

type ModelContextLike = {
  registerTool?: (tool: unknown, options?: { signal?: AbortSignal }) => unknown
  getTools?: () => Promise<RegisteredTool[]>
  executeTool?: (tool: RegisteredTool | string, input?: string | unknown, options?: unknown) => Promise<unknown>
  provideContext?: (payload: { tools: unknown[] }) => unknown
  __executeEnhanced?: boolean
}

function findContext(): ModelContextLike | null {
  const candidates = [
    typeof document === 'undefined' ? undefined : (document as unknown as ModelContextHost).modelContext,
    typeof navigator === 'undefined' ? undefined : (navigator as unknown as ModelContextHost).modelContext,
  ]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && ('registerTool' in candidate || 'provideContext' in candidate)) {
      return candidate as ModelContextLike
    }
  }
  return null
}

/**
 * Enhances `document.modelContext.executeTool` to tolerate being called with:
 *  - either a RegisteredTool object or a string tool name
 *  - either a serialized JSON string or a plain JavaScript object
 */
function enhanceExecuteTool(context: ModelContextLike): void {
  if (typeof context.executeTool !== 'function' || context.__executeEnhanced) return
  const originalExecuteTool = context.executeTool.bind(context)

  context.executeTool = async (
    toolOrName: RegisteredTool | string,
    rawInput: unknown = {},
    options?: unknown,
  ) => {
    let targetTool: RegisteredTool | null = null
    if (typeof toolOrName === 'string') {
      const tools: RegisteredTool[] = (await context.getTools?.()) ?? []
      targetTool = tools.find((t) => t.name === toolOrName) || null
      if (!targetTool) {
        throw new Error(`Tool not found: ${toolOrName}`)
      }
    } else {
      targetTool = toolOrName
    }

    const inputArgsJson =
      typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput ?? {})

    return originalExecuteTool(targetTool, inputArgsJson, options)
  }

  context.__executeEnhanced = true
}

// ------------------------------------------------------------- registration ----

let activeRegistration: {
  controller: AbortController
  disposers: Array<() => void>
} | null = null

export function registerAgentTools(onUpdate?: (count: number) => void): AgentRegistration {
  // If a previous registration is active (e.g. from React StrictMode remount or HMR),
  // abort it cleanly before registering the fresh set.
  if (activeRegistration) {
    try {
      activeRegistration.controller.abort()
      for (const dispose of activeRegistration.disposers) {
        dispose()
      }
    } catch {
      // ignore teardown errors from previous instance
    }
    activeRegistration = null
  }

  ensureWebMCPInitialized()

  const context = findContext()
  if (!context) {
    return { toolCount: 0, supported: false, isNative: false, dispose: noop }
  }

  enhanceExecuteTool(context)

  const isNative = nativeDetected
  const controller = new AbortController()
  const disposers: Array<() => void> = []
  activeRegistration = { controller, disposers }

  const descriptors = agentTools.map(toDescriptor)
  let registeredCount = 0

  const register = context.registerTool
  if (typeof register === 'function') {
    for (const descriptor of descriptors) {
      try {
        const returned = register.call(context, descriptor, { signal: controller.signal })
        void Promise.resolve(returned)
          .then((value: unknown) => {
            registeredCount++
            onUpdate?.(registeredCount)
            if (typeof value === 'function') {
              disposers.push(value as () => void)
            } else if (value && typeof (value as { dispose?: () => void }).dispose === 'function') {
              disposers.push(() => (value as { dispose: () => void }).dispose())
            }
          })
          .catch((cause: unknown) => {
            const msg = String(cause)
            // If already registered in this document (e.g. rapid StrictMode reload),
            // consider it present.
            if (msg.includes('already registered') || msg.includes('InvalidStateError')) {
              registeredCount++
              onUpdate?.(registeredCount)
            } else {
              console.warn(`[webmcp] registering ${descriptor.name} failed:`, cause)
            }
          })
      } catch (err: unknown) {
        const msg = String(err)
        if (msg.includes('already registered') || msg.includes('InvalidStateError')) {
          registeredCount++
          onUpdate?.(registeredCount)
        } else {
          console.warn(`[webmcp] synchronous registration error for ${descriptor.name}:`, err)
        }
      }
    }

    // Expose convenient window.webmcp helper for console and agent exploration
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).webmcp = {
        getTools: () => context.getTools?.() ?? Promise.resolve([]),
        executeTool: (name: string, input: unknown = {}) =>
          context.executeTool?.(name, input),
        tools: agentTools,
        isNative,
      }
    }

    return {
      toolCount: descriptors.length,
      supported: true,
      isNative,
      dispose: () => {
        controller.abort()
        for (const disposer of disposers) {
          try {
            disposer()
          } catch {
            // ignore cleanup errors
          }
        }
        if (activeRegistration?.controller === controller) {
          activeRegistration = null
        }
      },
    }
  }

  // Fallback for deprecated declarative provideContext API
  if (typeof context.provideContext === 'function') {
    try {
      context.provideContext({ tools: descriptors })
      return {
        toolCount: descriptors.length,
        supported: true,
        isNative,
        dispose: () => {
          try {
            context.provideContext?.({ tools: [] })
          } catch (cause) {
            console.warn('[webmcp] could not withdraw tools', cause)
          }
        },
      }
    } catch (cause) {
      console.warn('[webmcp] provideContext failed', cause)
    }
  }

  return { toolCount: 0, supported: false, isNative: false, dispose: noop }
}
