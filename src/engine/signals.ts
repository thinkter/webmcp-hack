/**
 * Per-frame evaluation of the signal (CHOP) half of the graph.
 *
 * Signals are plain CPU scalars, evaluated in dependency order once per frame
 * before any GPU work. Each node keeps persistent scratch state so operators
 * with memory — lag, timers, oscillator phase, beat counters — behave correctly
 * across frames without the renderer knowing anything about them.
 */

import { audioEngine } from '../audio/engine'
import { midiEngine } from '../audio/midi'
import type { AudioFrame, ChopContext } from './ops/kit'
import type { Plan } from './compile'
import { resolveParams } from '../graph/store'
import type { PatchNode } from '../graph/types'

const SILENT_SPECTRUM = new Float32Array(1024)

const SILENT_AUDIO: AudioFrame = {
  active: false,
  level: 0,
  peak: 0,
  spectrum: SILENT_SPECTRUM,
  sampleRate: 48000,
  fftSize: 2048,
  beat: 0,
  beatPulse: false,
  bpm: 0,
}

export type PointerState = { x: number; y: number; down: number }

export class SignalRuntime {
  /** Persistent per-node scratch, keyed by node id. */
  private readonly state = new Map<string, Record<string, number>>()
  private readonly values = new Map<string, number>()
  readonly pointer: PointerState = { x: 0.5, y: 0.5, down: 0 }

  private frame = 0
  private time = 0

  /** Latest evaluated value per signal node, for meters and WebMCP readouts. */
  get snapshot(): Map<string, number> {
    return this.values
  }

  value(nodeId: string): number {
    return this.values.get(nodeId) ?? 0
  }

  reset(): void {
    this.state.clear()
    this.values.clear()
    this.time = 0
    this.frame = 0
  }

  /** Drops scratch for nodes that no longer exist, so state cannot leak. */
  prune(liveIds: Set<string>): void {
    for (const id of this.state.keys()) if (!liveIds.has(id)) this.state.delete(id)
    for (const id of this.values.keys()) if (!liveIds.has(id)) this.values.delete(id)
  }

  evaluate(plan: Plan, nodes: Map<string, PatchNode>, delta: number, playing: boolean): void {
    if (playing) {
      this.time += delta
      this.frame += 1
    }

    const audio = audioEngine.state === 'running' ? audioEngine.frame : SILENT_AUDIO
    const band = (lowHz: number, highHz: number) =>
      audio.active ? audioEngine.bandEnergy(lowHz, highHz) : 0
    const midi = (channel: number, controller: number) => midiEngine.value(channel, controller)

    for (const id of plan.chopOrder) {
      const planNode = plan.nodes.get(id)
      const node = nodes.get(id)
      if (!planNode || !node || !planNode.spec.evaluate) {
        this.values.set(id, 0)
        continue
      }

      if (planNode.disabled) {
        // A disabled signal holds its last value rather than snapping to zero,
        // which avoids a visual jolt when muting part of a patch mid-show.
        this.values.set(id, this.values.get(id) ?? 0)
        continue
      }

      let scratch = this.state.get(id)
      if (!scratch) {
        scratch = {}
        this.state.set(id, scratch)
      }

      const context: ChopContext = {
        time: this.time,
        delta: playing ? delta : 0,
        frame: this.frame,
        inputs: planNode.inputs.map((input) => (input ? (this.values.get(input) ?? 0) : 0)),
        params: resolveParams(node) as Record<string, number | string | boolean>,
        state: scratch,
        audio,
        band,
        pointer: this.pointer,
        midi,
      }

      try {
        const result = planNode.spec.evaluate(context)
        this.values.set(id, Number.isFinite(result) ? result : 0)
      } catch (reason) {
        // A misbehaving evaluator must not take down the render loop.
        console.error(`[signals] ${planNode.op} (${id}) failed:`, reason)
        this.values.set(id, 0)
      }
    }
  }
}
