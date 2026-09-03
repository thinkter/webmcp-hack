/**
 * Numeric signal operators (CHOPs).
 *
 * These are evaluated once per frame on the CPU, before any GPU work, and the
 * resulting scalar can be wired into any modulatable parameter of any texture
 * operator. That single rule is what makes the patch audio-reactive: there is
 * no special "audio" path through the renderer, only ordinary parameters being
 * driven by ordinary signals.
 */

import { BOOL, DEVICE, F, INT, MENU, chop, type ChopContext, type OperatorSpec } from './kit'

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const bool = (value: unknown): boolean => value === true || value === 1

/**
 * One-pole smoothing with separate attack and release times, expressed in
 * seconds to reach ~63% of a step. Frame-rate independent, which matters
 * because the editor throttles rendering when a tab is backgrounded.
 */
function lag(current: number, target: number, seconds: number, delta: number): number {
  if (seconds <= 1e-4) return target
  const alpha = 1 - Math.exp(-delta / seconds)
  return current + (target - current) * alpha
}

const constantChop = chop({
  id: 'constant-chop',
  label: 'Constant',
  category: 'control',
  description: 'Holds a fixed value. The simplest way to drive a parameter from the graph.',
  td: 'Constant CHOP',
  keywords: ['value', 'number', 'fixed', 'slider'],
  inputs: [],
  params: [F('value', 'Value', 0.5, -10, 10)],
  evaluate: (ctx) => num(ctx.params.value),
})

const lfo = chop({
  id: 'lfo',
  label: 'LFO',
  category: 'control',
  description: 'Low-frequency oscillator with the usual waveform selection.',
  td: 'LFO CHOP',
  keywords: ['oscillator', 'sine', 'wave', 'cycle', 'pulse', 'modulate', 'animate'],
  inputs: [],
  params: [
    MENU('shape', 'Shape', 0, [
      'Sine',
      'Triangle',
      'Sawtooth',
      'Ramp Down',
      'Square',
      'Random',
      'Smooth Random',
    ]),
    F('frequency', 'Frequency', 0.5, 0, 20, { unit: 'Hz', log: true }),
    F('amplitude', 'Amplitude', 0.5, 0, 4),
    F('offset', 'Offset', 0.5, -4, 4),
    F('phase', 'Phase', 0, 0, 1),
    F('pulseWidth', 'Pulse Width', 0.5, 0.01, 0.99, { help: 'Square wave duty cycle.' }),
    BOOL('bipolar', 'Bipolar', false, { help: 'Swings -1..1 instead of 0..1 before scaling.' }),
  ],
  evaluate: (ctx) => {
    const frequency = num(ctx.params.frequency, 0.5)
    // Integrate phase rather than using absolute time, so changing the
    // frequency slider does not make the waveform jump.
    ctx.state.phase = (ctx.state.phase ?? 0) + ctx.delta * frequency
    const t = (ctx.state.phase + num(ctx.params.phase)) % 1
    const cycle = t < 0 ? t + 1 : t

    let raw: number
    switch (Math.round(num(ctx.params.shape))) {
      case 1:
        raw = 1 - Math.abs(cycle * 2 - 1)
        break
      case 2:
        raw = cycle
        break
      case 3:
        raw = 1 - cycle
        break
      case 4:
        raw = cycle < num(ctx.params.pulseWidth, 0.5) ? 1 : 0
        break
      case 5: {
        const step = Math.floor(ctx.state.phase)
        if (step !== ctx.state.lastStep) {
          ctx.state.lastStep = step
          ctx.state.held = Math.random()
        }
        raw = ctx.state.held ?? 0.5
        break
      }
      case 6: {
        const step = Math.floor(ctx.state.phase)
        if (step !== ctx.state.lastStep) {
          ctx.state.lastStep = step
          ctx.state.previous = ctx.state.held ?? 0.5
          ctx.state.held = Math.random()
        }
        const blend = ctx.state.phase - Math.floor(ctx.state.phase)
        const eased = blend * blend * (3 - 2 * blend)
        raw = (ctx.state.previous ?? 0.5) * (1 - eased) + (ctx.state.held ?? 0.5) * eased
        break
      }
      default:
        raw = Math.sin(cycle * Math.PI * 2) * 0.5 + 0.5
    }

    const signal = bool(ctx.params.bipolar) ? raw * 2 - 1 : raw
    return signal * num(ctx.params.amplitude, 1) + num(ctx.params.offset)
  },
})

const noiseChop = chop({
  id: 'noise-chop',
  label: 'Noise',
  category: 'control',
  description: 'Smoothly wandering random signal. Good for organic drift.',
  td: 'Noise CHOP',
  keywords: ['random', 'drift', 'wander', 'perlin', 'jitter', 'organic'],
  inputs: [],
  params: [
    F('speed', 'Speed', 0.4, 0, 10, { unit: 'Hz' }),
    F('roughness', 'Roughness', 0.5, 0, 1, { help: 'Blends smooth drift into jitter.' }),
    F('amplitude', 'Amplitude', 0.5, 0, 4),
    F('offset', 'Offset', 0.5, -4, 4),
  ],
  evaluate: (ctx) => {
    ctx.state.phase = (ctx.state.phase ?? Math.random() * 100) + ctx.delta * num(ctx.params.speed, 0.4)
    const step = Math.floor(ctx.state.phase)
    if (step !== ctx.state.lastStep) {
      ctx.state.lastStep = step
      ctx.state.previous = ctx.state.held ?? Math.random()
      ctx.state.held = Math.random()
    }
    const blend = ctx.state.phase - step
    const eased = blend * blend * (3 - 2 * blend)
    const smooth = (ctx.state.previous ?? 0.5) * (1 - eased) + (ctx.state.held ?? 0.5) * eased
    const rough = num(ctx.params.roughness)
    const raw = smooth * (1 - rough) + Math.random() * rough
    return (raw - 0.5) * 2 * num(ctx.params.amplitude, 1) * 0.5 + num(ctx.params.offset)
  },
})

const mathChop = chop({
  id: 'math-chop',
  label: 'Math',
  category: 'control',
  description: 'Combines two signals, or a signal and a constant, with one arithmetic operation.',
  td: 'Math CHOP',
  keywords: ['add', 'multiply', 'combine', 'arithmetic', 'mix', 'sum'],
  inputs: ['Value 1', 'Value 2'],
  params: [
    MENU('operation', 'Operation', 2, [
      'Add',
      'Subtract',
      'Multiply',
      'Divide',
      'Minimum',
      'Maximum',
      'Average',
      'Power',
      'Modulo',
      'Difference',
    ]),
    F('operand', 'Operand', 1, -10, 10, {
      help: 'Used in place of the second input when nothing is wired.',
    }),
    F('preAdd', 'Pre Add', 0, -10, 10),
    F('postMultiply', 'Post Multiply', 1, -10, 10),
  ],
  evaluate: (ctx) => {
    const a = (ctx.inputs[0] ?? 0) + num(ctx.params.preAdd)
    const b = ctx.inputs.length > 1 ? ctx.inputs[1] : num(ctx.params.operand, 1)

    let result: number
    switch (Math.round(num(ctx.params.operation, 2))) {
      case 0: result = a + b; break
      case 1: result = a - b; break
      case 3: result = Math.abs(b) < 1e-6 ? 0 : a / b; break
      case 4: result = Math.min(a, b); break
      case 5: result = Math.max(a, b); break
      case 6: result = (a + b) / 2; break
      case 7: result = Math.sign(a) * Math.pow(Math.abs(a), b); break
      case 8: result = Math.abs(b) < 1e-6 ? 0 : ((a % b) + b) % b; break
      case 9: result = Math.abs(a - b); break
      default: result = a * b
    }

    const value = result * num(ctx.params.postMultiply, 1)
    return Number.isFinite(value) ? value : 0
  },
})

const rangeChop = chop({
  id: 'range',
  label: 'Range',
  category: 'control',
  description: 'Remaps an input range onto an output range, with optional clamping and curve.',
  td: 'Math CHOP (range)',
  keywords: ['map', 'remap', 'scale', 'fit', 'normalize', 'clamp'],
  inputs: ['Value'],
  params: [
    F('fromLow', 'From Low', 0, -10, 10),
    F('fromHigh', 'From High', 1, -10, 10),
    F('toLow', 'To Low', 0, -10, 10),
    F('toHigh', 'To High', 1, -10, 10),
    F('curve', 'Curve', 1, 0.1, 6, { help: 'Exponent applied to the normalised value.' }),
    BOOL('clamp', 'Clamp', true),
    BOOL('invert', 'Invert', false),
  ],
  evaluate: (ctx) => {
    const fromLow = num(ctx.params.fromLow)
    const fromHigh = num(ctx.params.fromHigh, 1)
    const span = fromHigh - fromLow
    let t = Math.abs(span) < 1e-9 ? 0 : ((ctx.inputs[0] ?? 0) - fromLow) / span
    if (bool(ctx.params.clamp)) t = Math.min(1, Math.max(0, t))
    if (bool(ctx.params.invert)) t = 1 - t
    const curve = num(ctx.params.curve, 1)
    if (curve !== 1) t = Math.sign(t) * Math.pow(Math.abs(t), curve)
    return num(ctx.params.toLow) + t * (num(ctx.params.toHigh, 1) - num(ctx.params.toLow))
  },
})

const lagChop = chop({
  id: 'lag',
  label: 'Lag',
  category: 'control',
  description: 'Smooths a signal with independent attack and release times.',
  td: 'Lag CHOP',
  keywords: ['smooth', 'filter', 'slew', 'envelope', 'damp', 'ease'],
  inputs: ['Value'],
  params: [
    F('attack', 'Attack', 0.05, 0, 4, { unit: 's', help: 'Time to rise toward a higher value.' }),
    F('release', 'Release', 0.35, 0, 4, { unit: 's', help: 'Time to fall toward a lower value.' }),
  ],
  evaluate: (ctx) => {
    const target = ctx.inputs[0] ?? 0
    const current = ctx.state.value ?? target
    const seconds = target > current ? num(ctx.params.attack, 0.05) : num(ctx.params.release, 0.35)
    ctx.state.value = lag(current, target, seconds, ctx.delta)
    return ctx.state.value
  },
})

const timer = chop({
  id: 'timer',
  label: 'Timer',
  category: 'control',
  description: 'Counts through a cycle and reports position, elapsed time, or a cycle pulse.',
  td: 'Timer CHOP',
  keywords: ['clock', 'ramp', 'cycle', 'countdown', 'sequence', 'loop'],
  inputs: [],
  params: [
    F('length', 'Length', 4, 0.05, 600, { unit: 's', log: true }),
    BOOL('play', 'Play', true),
    BOOL('loop', 'Loop', true),
    BOOL('reset', 'Reset', false),
    MENU('output', 'Output', 0, ['Ramp', 'Seconds', 'Cycles', 'Pulse', 'Ease']),
  ],
  evaluate: (ctx) => {
    const length = Math.max(0.05, num(ctx.params.length, 4))
    if (bool(ctx.params.reset)) {
      ctx.state.elapsed = 0
      ctx.state.cycles = 0
    }
    if (bool(ctx.params.play)) ctx.state.elapsed = (ctx.state.elapsed ?? 0) + ctx.delta

    let elapsed = ctx.state.elapsed ?? 0
    let pulse = 0
    if (elapsed >= length) {
      if (bool(ctx.params.loop)) {
        const completed = Math.floor(elapsed / length)
        ctx.state.cycles = (ctx.state.cycles ?? 0) + completed
        elapsed -= completed * length
        ctx.state.elapsed = elapsed
        pulse = 1
      } else {
        elapsed = length
        ctx.state.elapsed = length
      }
    }

    const ramp = elapsed / length
    switch (Math.round(num(ctx.params.output))) {
      case 1: return elapsed
      case 2: return ctx.state.cycles ?? 0
      case 3: return pulse
      case 4: return ramp * ramp * (3 - 2 * ramp)
      default: return ramp
    }
  },
})

const tempo = chop({
  id: 'tempo',
  label: 'Tempo',
  category: 'control',
  description: 'Musical clock in BPM with beat divisions, for locking visuals to a track.',
  td: 'Beat CHOP',
  keywords: ['bpm', 'beat', 'bar', 'metronome', 'sync', 'music', 'clock'],
  inputs: [],
  params: [
    F('bpm', 'BPM', 128, 20, 300),
    F('division', 'Division', 1, 0.125, 16, {
      help: '1 = quarter note, 2 = eighth note, 0.25 = whole bar.',
    }),
    MENU('output', 'Output', 0, ['Ramp', 'Pulse', 'Sine', 'Decay', 'Square']),
    F('decay', 'Decay', 0.25, 0.01, 4, { unit: 's', help: 'Only used by the Decay output.' }),
    BOOL('followAudio', 'Follow Audio', false, {
      help: 'Uses the detected tempo from the audio input when one is available.',
    }),
    BOOL('sync', 'Sync', false, { help: 'Restarts the phase while enabled.' }),
  ],
  evaluate: (ctx) => {
    const detected = ctx.audio.bpm
    const bpm =
      bool(ctx.params.followAudio) && detected > 0 ? detected : Math.max(1, num(ctx.params.bpm, 128))
    const hz = (bpm / 60) * Math.max(0.001, num(ctx.params.division, 1))

    if (bool(ctx.params.sync)) ctx.state.phase = 0
    const previous = ctx.state.phase ?? 0
    ctx.state.phase = previous + ctx.delta * hz
    const wrapped = ctx.state.phase % 1
    const crossed = Math.floor(ctx.state.phase) !== Math.floor(previous)

    if (crossed) ctx.state.sinceBeat = 0
    else ctx.state.sinceBeat = (ctx.state.sinceBeat ?? 999) + ctx.delta

    switch (Math.round(num(ctx.params.output))) {
      case 1: return crossed ? 1 : 0
      case 2: return Math.sin(wrapped * Math.PI * 2) * 0.5 + 0.5
      case 3: return Math.exp(-(ctx.state.sinceBeat ?? 999) / Math.max(0.01, num(ctx.params.decay, 0.25)))
      case 4: return wrapped < 0.5 ? 1 : 0
      default: return wrapped
    }
  },
})

const audioIn = chop({
  id: 'audio-in',
  label: 'Audio In',
  category: 'audio',
  description: 'Overall loudness of the live audio input.',
  td: 'Audio Device In CHOP',
  keywords: ['microphone', 'mic', 'level', 'rms', 'volume', 'loudness', 'sound'],
  inputs: [],
  params: [
    DEVICE('deviceId', 'Device'),
    BOOL('active', 'Active', true),
    MENU('measure', 'Measure', 0, ['RMS', 'Peak']),
    F('gain', 'Gain', 1, 0, 16, { log: true }),
    F('smoothing', 'Smoothing', 0.1, 0, 2, { unit: 's' }),
    F('floor', 'Noise Floor', 0.02, 0, 0.5, { help: 'Subtracted before gain, to reject hiss.' }),
  ],
  evaluate: (ctx) => {
    const raw = Math.round(num(ctx.params.measure)) === 1 ? ctx.audio.peak : ctx.audio.level
    const gated = Math.max(0, raw - num(ctx.params.floor, 0.02))
    const target = Math.min(4, gated * num(ctx.params.gain, 1))
    ctx.state.value = lag(ctx.state.value ?? 0, target, num(ctx.params.smoothing, 0.1), ctx.delta)
    return ctx.state.value
  },
})

const AUDIO_BANDS: Array<[number, number]> = [
  [20, 140],
  [140, 400],
  [400, 2000],
  [2000, 6000],
  [6000, 16000],
  [20, 20000],
]

const audioBand = chop({
  id: 'audio-band',
  label: 'Audio Band',
  category: 'audio',
  description: 'Energy in a frequency band. The fastest route to a bass-reactive patch.',
  td: 'Audio Spectrum CHOP',
  keywords: ['bass', 'mid', 'treble', 'fft', 'spectrum', 'frequency', 'eq', 'kick'],
  inputs: [],
  params: [
    MENU('band', 'Band', 0, ['Bass', 'Low Mid', 'Mid', 'High Mid', 'Treble', 'Full', 'Custom']),
    F('lowHz', 'Low', 20, 20, 20000, { log: true, unit: 'Hz', help: 'Used when Band is Custom.' }),
    F('highHz', 'High', 140, 20, 20000, { log: true, unit: 'Hz' }),
    F('gain', 'Gain', 2, 0, 32, { log: true }),
    F('smoothing', 'Smoothing', 0.08, 0, 2, { unit: 's' }),
    BOOL('normalize', 'Auto Gain', true, {
      help: 'Tracks the running maximum so quiet material still reaches 1.',
    }),
  ],
  evaluate: (ctx) => {
    const index = Math.round(num(ctx.params.band))
    const [low, high] =
      index >= AUDIO_BANDS.length
        ? [num(ctx.params.lowHz, 20), num(ctx.params.highHz, 140)]
        : AUDIO_BANDS[index]

    let energy = ctx.band(Math.min(low, high), Math.max(low, high)) * num(ctx.params.gain, 2)

    if (bool(ctx.params.normalize)) {
      // Slowly decaying peak tracker. Decaying rather than holding means a loud
      // transient does not permanently squash the rest of the set.
      const peak = Math.max(energy, (ctx.state.peak ?? 0.2) - ctx.delta * 0.15)
      ctx.state.peak = Math.max(0.05, peak)
      energy = energy / ctx.state.peak
    }

    ctx.state.value = lag(
      ctx.state.value ?? 0,
      Math.min(4, energy),
      num(ctx.params.smoothing, 0.08),
      ctx.delta,
    )
    return ctx.state.value
  },
})

const beat = chop({
  id: 'beat',
  label: 'Beat',
  category: 'audio',
  description: 'Fires on detected onsets and decays, for punchy hits on the kick.',
  td: 'Beat CHOP',
  keywords: ['onset', 'kick', 'transient', 'trigger', 'hit', 'pulse', 'drum'],
  inputs: [],
  params: [
    F('sensitivity', 'Sensitivity', 1, 0.1, 4),
    F('decay', 'Decay', 0.25, 0.02, 3, { unit: 's' }),
    MENU('output', 'Output', 0, ['Envelope', 'Pulse', 'Toggle', 'Count']),
    F('holdoff', 'Hold Off', 0.12, 0, 1, { unit: 's', help: 'Minimum time between triggers.' }),
  ],
  evaluate: (ctx) => {
    ctx.state.since = (ctx.state.since ?? 999) + ctx.delta
    const armed = ctx.state.since >= num(ctx.params.holdoff, 0.12)
    const fired = ctx.audio.beatPulse && armed && ctx.audio.beat * num(ctx.params.sensitivity, 1) > 0.5

    if (fired) {
      ctx.state.since = 0
      ctx.state.toggle = ctx.state.toggle === 1 ? 0 : 1
      ctx.state.count = (ctx.state.count ?? 0) + 1
    }

    switch (Math.round(num(ctx.params.output))) {
      case 1: return fired ? 1 : 0
      case 2: return ctx.state.toggle ?? 0
      case 3: return ctx.state.count ?? 0
      default: return Math.exp(-(ctx.state.since ?? 999) / Math.max(0.02, num(ctx.params.decay, 0.25)))
    }
  },
})

const midiIn = chop({
  id: 'midi-in',
  label: 'MIDI In',
  category: 'control',
  description: 'Reads a MIDI continuous controller, so a hardware knob can drive a parameter.',
  td: 'MIDI In CHOP',
  keywords: ['controller', 'cc', 'knob', 'fader', 'hardware', 'launchpad', 'apc'],
  inputs: [],
  params: [
    INT('channel', 'Channel', 0, 0, 16, { help: '0 listens on every channel; 1–16 selects a channel.' }),
    INT('controller', 'Controller', 1, 0, 127),
    F('low', 'Low', 0, -10, 10),
    F('high', 'High', 1, -10, 10),
    F('smoothing', 'Smoothing', 0.04, 0, 1, { unit: 's' }),
  ],
  evaluate: (ctx) => {
    const raw = ctx.midi(Math.round(num(ctx.params.channel)), Math.round(num(ctx.params.controller, 1)))
    const target = num(ctx.params.low) + raw * (num(ctx.params.high, 1) - num(ctx.params.low))
    ctx.state.value = lag(ctx.state.value ?? target, target, num(ctx.params.smoothing, 0.04), ctx.delta)
    return ctx.state.value
  },
})

const pointer = chop({
  id: 'pointer',
  label: 'Pointer',
  category: 'control',
  description: 'Mouse or touch position over the program monitor, normalised 0..1.',
  td: 'Mouse In CHOP',
  keywords: ['mouse', 'touch', 'cursor', 'interactive', 'xy', 'drag'],
  inputs: [],
  params: [
    MENU('axis', 'Axis', 0, ['X', 'Y', 'Pressed', 'Distance From Centre']),
    F('smoothing', 'Smoothing', 0.06, 0, 1, { unit: 's' }),
    F('low', 'Low', 0, -10, 10),
    F('high', 'High', 1, -10, 10),
  ],
  evaluate: (ctx) => {
    let raw: number
    switch (Math.round(num(ctx.params.axis))) {
      case 1: raw = ctx.pointer.y; break
      case 2: raw = ctx.pointer.down; break
      case 3: raw = Math.min(1, Math.hypot(ctx.pointer.x - 0.5, ctx.pointer.y - 0.5) * 2); break
      default: raw = ctx.pointer.x
    }
    const target = num(ctx.params.low) + raw * (num(ctx.params.high, 1) - num(ctx.params.low))
    ctx.state.value = lag(ctx.state.value ?? target, target, num(ctx.params.smoothing, 0.06), ctx.delta)
    return ctx.state.value
  },
})

export const chopOperators: OperatorSpec[] = [
  constantChop,
  lfo,
  noiseChop,
  mathChop,
  rangeChop,
  lagChop,
  timer,
  tempo,
  audioIn,
  audioBand,
  beat,
  midiIn,
  pointer,
]

export type { ChopContext }
