import type { AudioFrame } from '../engine/ops/kit'

export type AudioEngineState = 'idle' | 'starting' | 'running' | 'error'

export interface AudioEngine {
  /** Latest analysis. Never null; returns a silent frame when not running. */
  readonly frame: AudioFrame
  readonly state: AudioEngineState
  readonly error: string | null
  readonly deviceId: string | null
  /** Enumerate audio input devices. Labels are only populated after permission. */
  listDevices(): Promise<Array<{ deviceId: string; label: string }>>
  /** Start (or switch to) a microphone. Safe to call repeatedly with the same id. */
  start(deviceId?: string): Promise<void>
  /** Analyse an <audio>/<video> element or a MediaStream instead of a mic. */
  attachStream(stream: MediaStream): Promise<void>
  stop(): void
  /** Called exactly once per render frame, before CHOPs are evaluated. */
  update(deltaSeconds: number): void
  /** Mean normalised magnitude between two frequencies in Hz. */
  bandEnergy(lowHz: number, highHz: number): number
  /** Notifies on state/device/error changes only — NOT per audio frame. */
  subscribe(listener: () => void): () => void
}

// --- Analysis geometry -------------------------------------------------------

/**
 * 2048 samples ≈ 43 ms at 48 kHz: long enough for ~23 Hz bin resolution (so the
 * bass band is more than two bins wide) and short enough that a kick transient
 * is not smeared across several render frames.
 */
const FFT_SIZE = 2048
const BIN_COUNT = FFT_SIZE / 2

/**
 * The AnalyserNode's own temporal smoothing. 0.6 removes the frame-to-frame
 * jitter that makes spectrum bars look noisy, while still leaving enough
 * transient definition for onset detection to work on the smoothed data.
 */
const SMOOTHING_TIME_CONSTANT = 0.6

/**
 * Byte frequency data is normalised across [minDecibels, maxDecibels]. Widening
 * the floor to -90 dB keeps quiet material visible; capping at -10 dB rather
 * than 0 dB means a normally-mastered track reaches the top of the range
 * instead of sitting permanently at half scale.
 */
const MIN_DECIBELS = -90
const MAX_DECIBELS = -10

// --- Envelopes ---------------------------------------------------------------

/** One-pole time constant for `level`. Short enough to feel immediate. */
const LEVEL_TAU = 0.05
/** `peak` attacks instantly and releases over this, mimicking a VU meter. */
const PEAK_RELEASE_TAU = 0.18

// --- Onset detection ---------------------------------------------------------

/**
 * ~1.6 s of flux history at 60 fps. Long enough that the mean/deviation
 * describe "this section of the track" rather than "this bar", short enough to
 * adapt when the energy of the material changes (a drop, a breakdown).
 */
const FLUX_HISTORY = 96
/** Below this many samples the statistics are meaningless, so stay silent. */
const FLUX_MIN_HISTORY = 30
/** Threshold multiplier on the standard deviation. ~1.6σ ≈ kick, not hi-hat. */
const FLUX_THRESHOLD_K = 1.6
/**
 * Absolute floor on the weighted mean flux. Without it, a room mic in near
 * silence produces onsets from its own noise, because noise still has a
 * mean and a deviation.
 */
const FLUX_FLOOR = 0.0015
/**
 * Low-frequency tilt: weight = 1 / (1 + hz / 400). A 60 Hz kick keeps ~0.87 of
 * its contribution, a 1 kHz snare ~0.29, a 6 kHz hat ~0.06. Onsets should track
 * the drum that defines the tempo, and cymbals/vocal sibilance are both the
 * loudest and the least rhythmically reliable part of a broadband spectrum.
 */
const FLUX_TILT_HZ = 400
/** Everything above this is essentially cymbals; excluded to save work. */
const FLUX_MAX_HZ = 8000
/**
 * Refractory period. 100 ms ≈ a 1/16 note at 150 BPM, so it suppresses the
 * multiple frames of a single transient's rise without swallowing fast
 * legitimate hits.
 */
const REFRACTORY_SECONDS = 0.1
/** Frames to let the analyser fill before trusting the first difference. */
const WARMUP_FRAMES = 8
/** `beat` decays as exp(-t / 0.25), matching the Beat CHOP's default decay. */
const BEAT_DECAY_SECONDS = 0.25

// --- Tempo -------------------------------------------------------------------

/** 240 BPM .. 30 BPM. Anything outside is a double-trigger or a dropout. */
const MIN_INTERVAL = 0.25
const MAX_INTERVAL = 2.0
const INTERVAL_HISTORY = 12
/** Below this many intervals a median is not robust enough to publish. */
const MIN_INTERVALS_FOR_BPM = 6
/** Fold octaves into the range a DJ would actually call the tempo. */
const BPM_FOLD_LOW = 70
const BPM_FOLD_HIGH = 180
/** Intervals within ±8 % of the median count as agreeing with it. */
const BPM_AGREEMENT = 0.08
/** Fraction of the history that must agree before a tempo is reported. */
const BPM_MIN_AGREEING = 0.6
/** Silence longer than this means the previous tempo is stale. */
const BPM_STALE_SECONDS = 3
/** Per-frame blend of a new estimate into the published one. */
const BPM_BLEND = 0.25

/** Guards against a tab-switch handing us a multi-second delta. */
const MAX_DELTA = 0.1

type SourceKind = 'mic' | 'stream'

type AudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof globalThis === 'undefined') return null
  // webkitAudioContext is not in lib.dom; older Safari only exposes the prefix.
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor
  }
  if (typeof scope.AudioContext === 'function') return scope.AudioContext
  if (typeof scope.webkitAudioContext === 'function') return scope.webkitAudioContext
  return null
}

function hasMediaDevices(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    switch (cause.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was denied. Allow it in the browser site settings and try again.'
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No matching audio input device was found. Pick a different device.'
      case 'NotReadableError':
      case 'AbortError':
        return 'The audio device could not be read; it may be in use by another application.'
      default:
        return cause.message || fallback
    }
  }
  return fallback
}

/** Frame-rate independent one-pole coefficient for a time constant in seconds. */
function poleCoefficient(tau: number, delta: number): number {
  if (tau <= 0) return 1
  return 1 - Math.exp(-delta / tau)
}

class WebAudioEngine implements AudioEngine {
  // The frame object and every buffer inside it are allocated once and mutated
  // in place: this is read by every CHOP, every frame, next to GPU work.
  private readonly audioFrame: AudioFrame = {
    active: false,
    level: 0,
    peak: 0,
    spectrum: new Float32Array(BIN_COUNT),
    sampleRate: 0,
    fftSize: FFT_SIZE,
    beat: 0,
    beatPulse: false,
    bpm: 0,
  }

  private readonly previousSpectrum = new Float32Array(BIN_COUNT)
  private readonly fluxWeights = new Float32Array(BIN_COUNT)
  private readonly fluxHistory = new Float32Array(FLUX_HISTORY)
  private readonly intervals = new Float32Array(INTERVAL_HISTORY)
  private readonly intervalScratch = new Float32Array(INTERVAL_HISTORY)

  private frequencyBytes: Uint8Array<ArrayBuffer> = new Uint8Array(BIN_COUNT)
  private timeFloats: Float32Array<ArrayBuffer> = new Float32Array(FFT_SIZE)
  private timeBytes: Uint8Array<ArrayBuffer> = new Uint8Array(FFT_SIZE)

  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private sourceKind: SourceKind | null = null

  private currentState: AudioEngineState = 'idle'
  private currentError: string | null = null
  private currentDeviceId: string | null = null

  private readonly listeners = new Set<() => void>()

  /** Bumped on every start/stop so stale async work can be discarded. */
  private generation = 0
  private pending: Promise<void> | null = null
  private pendingDeviceId: string | null = null

  private fluxWeightSum = 0
  private fluxBinLimit = BIN_COUNT
  private fluxFilled = 0
  private fluxCursor = 0
  private warmup = 0
  private clock = 0
  private lastOnsetAt = -Infinity
  private intervalCount = 0
  private silenced = true

  get frame(): AudioFrame {
    return this.audioFrame
  }

  get state(): AudioEngineState {
    return this.currentState
  }

  get error(): string | null {
    return this.currentError
  }

  get deviceId(): string | null {
    return this.currentDeviceId
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async listDevices(): Promise<Array<{ deviceId: string; label: string }>> {
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
      return []
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          // Labels are empty until the user has granted permission at least
          // once, so give the UI something selectable in the meantime.
          label: device.label || `Audio input ${index + 1}`,
        }))
    } catch {
      return []
    }
  }

  start(deviceId?: string): Promise<void> {
    const requested = deviceId ?? null

    // Already listening to exactly this microphone: nothing to do.
    if (this.currentState === 'running' && this.sourceKind === 'mic' && this.currentDeviceId === requested) {
      return Promise.resolve()
    }
    // An identical start is already in flight; share its promise rather than
    // opening a second getUserMedia for the same device.
    if (this.pending && this.currentState === 'starting' && this.pendingDeviceId === requested) {
      return this.pending
    }

    const run = this.startMicrophone(requested)
    this.pending = run
    this.pendingDeviceId = requested
    return run
  }

  private async startMicrophone(requested: string | null): Promise<void> {
    if (!hasMediaDevices()) {
      this.fail('This browser does not expose microphone capture (navigator.mediaDevices is missing).')
      return
    }

    const generation = this.beginStart()

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(requested ? { deviceId: { exact: requested } } : {}),
          // All three of these are voice-call processing. Echo cancellation
          // gates and duckssteady music, noise suppression eats cymbals and
          // room tone, and auto gain control actively fights the dynamics we
          // are trying to measure — it flattens a kick within a second, which
          // is precisely the signal a VJ patch reacts to. They must stay off.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
    } catch (cause) {
      if (generation !== this.generation) return
      this.fail(describeError(cause, 'Could not open the audio input device.'))
      return
    }

    if (generation !== this.generation) {
      // Superseded while we were awaiting permission: release immediately.
      for (const track of stream.getTracks()) track.stop()
      return
    }

    await this.wire(stream, 'mic', requested, generation)
  }

  async attachStream(stream: MediaStream): Promise<void> {
    // For an <audio>/<video> element, pass `element.captureStream()` (or
    // `mozCaptureStream()`); we deliberately do not touch the element itself so
    // playback and routing to the speakers stay entirely the caller's business.
    // Note that stop() stops the tracks it was given, which ends a capture
    // stream for good — call captureStream() again to re-attach.
    const generation = this.beginStart()
    const run = this.wire(stream, 'stream', null, generation)
    this.pending = run
    this.pendingDeviceId = null
    await run
  }

  /** Tears down any previous graph and marks a new attempt as current. */
  private beginStart(): number {
    this.teardown()
    this.generation += 1
    this.setState('starting', null)
    return this.generation
  }

  private async wire(
    stream: MediaStream,
    kind: SourceKind,
    deviceId: string | null,
    generation: number,
  ): Promise<void> {
    const Constructor = getAudioContextConstructor()
    if (!Constructor) {
      for (const track of stream.getTracks()) track.stop()
      this.fail('This browser does not support the Web Audio API.')
      return
    }

    const context = new Constructor()

    // Autoplay policy: a context created outside a user gesture starts
    // suspended, and resume() only settles once a gesture has happened.
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch {
        // Swallowed deliberately: a rejected resume() and a resume() that never
        // takes effect are the same situation, and both are reported below by
        // inspecting context.state.
      }
    }

    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => undefined)
      return
    }

    if (context.state !== 'running') {
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => undefined)
      this.fail(
        'The browser blocked audio until the page receives a user gesture. Click anywhere in the page, then start the audio input again.',
      )
      return
    }

    let analyser: AnalyserNode
    let source: MediaStreamAudioSourceNode
    try {
      analyser = context.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = SMOOTHING_TIME_CONSTANT
      analyser.minDecibels = MIN_DECIBELS
      analyser.maxDecibels = MAX_DECIBELS

      // Throws if the stream carries no audio track, which is the common
      // mistake when passing a captureStream() from a silent video.
      source = context.createMediaStreamSource(stream)
      // Analyser only — never connected to context.destination. Routing a live
      // microphone back to the speakers is an instant feedback loop, and an
      // AnalyserNode pulls data without needing a downstream sink.
      source.connect(analyser)
    } catch (cause) {
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => undefined)
      this.fail(describeError(cause, 'That stream has no audio track to analyse.'))
      return
    }

    // frequencyBinCount is fftSize / 2, but an implementation is free to clamp
    // fftSize, so size the scratch buffers from what we actually got.
    if (analyser.frequencyBinCount !== this.frequencyBytes.length) {
      this.frequencyBytes = new Uint8Array(analyser.frequencyBinCount)
    }
    if (analyser.fftSize !== this.timeFloats.length) {
      this.timeFloats = new Float32Array(analyser.fftSize)
      this.timeBytes = new Uint8Array(analyser.fftSize)
    }

    for (const track of stream.getAudioTracks()) {
      // Fires when the user revokes permission from the browser UI or the
      // interface is unplugged. There is no recovering the same track, so drop
      // back to idle and let the UI offer a restart.
      track.addEventListener('ended', () => {
        if (generation !== this.generation) return
        this.teardown()
        this.setState('idle', null)
      })
    }

    this.context = context
    this.analyser = analyser
    this.source = source
    this.stream = stream
    this.sourceKind = kind
    this.currentDeviceId = kind === 'mic' ? deviceId : null

    this.audioFrame.sampleRate = context.sampleRate
    this.audioFrame.fftSize = analyser.fftSize
    this.prepareFluxWeights(context.sampleRate, analyser.fftSize, analyser.frequencyBinCount)
    this.resetAnalysis()

    this.pending = null
    this.pendingDeviceId = null
    this.setState('running', null)
  }

  stop(): void {
    this.generation += 1
    this.teardown()
    this.pending = null
    this.pendingDeviceId = null
    this.setState('idle', null)
  }

  private teardown(): void {
    if (this.source) {
      try {
        this.source.disconnect()
      } catch {
        // Already disconnected; nothing to release.
      }
      this.source = null
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect()
      } catch {
        // Already disconnected.
      }
      this.analyser = null
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
    if (this.context) {
      const context = this.context
      this.context = null
      if (context.state !== 'closed') void context.close().catch(() => undefined)
    }
    this.sourceKind = null
    this.currentDeviceId = null
    this.resetAnalysis()
  }

  private fail(message: string): void {
    this.teardown()
    this.pending = null
    this.pendingDeviceId = null
    this.setState('error', message)
  }

  private setState(next: AudioEngineState, error: string | null): void {
    const changed = this.currentState !== next || this.currentError !== error
    this.currentState = next
    this.currentError = error
    if (changed) this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (cause) {
        // A broken subscriber must not stop the others from being told.
        console.error('[audio] subscriber threw', cause)
      }
    }
  }

  private prepareFluxWeights(sampleRate: number, fftSize: number, bins: number): void {
    const binWidth = sampleRate / fftSize
    const limit = Math.min(bins, Math.max(1, Math.ceil(FLUX_MAX_HZ / binWidth)))
    this.fluxWeights.fill(0)
    let sum = 0
    for (let bin = 0; bin < limit; bin += 1) {
      const hz = (bin + 0.5) * binWidth
      const weight = 1 / (1 + hz / FLUX_TILT_HZ)
      this.fluxWeights[bin] = weight
      sum += weight
    }
    this.fluxBinLimit = limit
    // Normalising by the weight sum makes flux a mean rather than a sum, so
    // FLUX_FLOOR stays meaningful regardless of fftSize or sample rate.
    this.fluxWeightSum = sum > 0 ? sum : 1
  }

  private resetAnalysis(): void {
    this.previousSpectrum.fill(0)
    this.fluxHistory.fill(0)
    this.fluxFilled = 0
    this.fluxCursor = 0
    this.warmup = 0
    this.intervalCount = 0
    this.lastOnsetAt = -Infinity
    this.silenced = false
  }

  update(deltaSeconds: number): void {
    // This runs inside the render loop; a throw here would kill the frame.
    try {
      const delta = Number.isFinite(deltaSeconds) ? Math.min(MAX_DELTA, Math.max(0, deltaSeconds)) : 0
      this.clock += delta

      const analyser = this.analyser
      if (!analyser || this.currentState !== 'running') {
        this.decayToSilence(delta)
        return
      }

      this.silenced = false
      const frame = this.audioFrame
      frame.active = true

      analyser.getByteFrequencyData(this.frequencyBytes)
      this.readTimeDomain(analyser)

      // Byte frequency data, not float dB data: the browser has already mapped
      // [minDecibels, maxDecibels] onto 0..255, which gives us a bounded,
      // dB-scaled 0..1 magnitude for free. getFloatFrequencyData would hand
      // back raw dB including -Infinity for empty bins, which we would then
      // have to clamp and rescale by exactly the same curve.
      const spectrum = frame.spectrum
      const bytes = this.frequencyBytes
      const bins = Math.min(spectrum.length, bytes.length)
      for (let bin = 0; bin < bins; bin += 1) spectrum[bin] = bytes[bin] / 255

      this.measureLoudness(delta)
      this.detectOnset(delta)
    } catch (cause) {
      console.error('[audio] analysis frame failed', cause)
    }
  }

  private readTimeDomain(analyser: AnalyserNode): void {
    // Float time-domain data is unclipped and precise at low level, which
    // matters for RMS. Older WebKit only has the byte version.
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      analyser.getFloatTimeDomainData(this.timeFloats)
      return
    }
    analyser.getByteTimeDomainData(this.timeBytes)
    const floats = this.timeFloats
    const bytes = this.timeBytes
    const count = Math.min(floats.length, bytes.length)
    for (let i = 0; i < count; i += 1) floats[i] = (bytes[i] - 128) / 128
  }

  private measureLoudness(delta: number): void {
    const samples = this.timeFloats
    let sumSquares = 0
    let maxAbs = 0
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]
      sumSquares += sample * sample
      const magnitude = sample < 0 ? -sample : sample
      if (magnitude > maxAbs) maxAbs = magnitude
    }

    const rms = Math.min(1, Math.sqrt(sumSquares / samples.length))
    const frame = this.audioFrame
    frame.level += (rms - frame.level) * poleCoefficient(LEVEL_TAU, delta)

    const peak = Math.min(1, maxAbs)
    // Fast attack, slow release: a transient should read at full height on the
    // frame it happens, then fall back gently instead of flickering.
    frame.peak =
      peak > frame.peak ? peak : frame.peak + (peak - frame.peak) * poleCoefficient(PEAK_RELEASE_TAU, delta)
  }

  private detectOnset(delta: number): void {
    const frame = this.audioFrame
    const spectrum = frame.spectrum
    const previous = this.previousSpectrum
    const weights = this.fluxWeights

    // Spectral flux: only *increases* in energy count. Half-wave rectifying is
    // what separates an attack from a decay — a note ending is not an onset.
    let flux = 0
    for (let bin = 0; bin < this.fluxBinLimit; bin += 1) {
      const difference = spectrum[bin] - previous[bin]
      if (difference > 0) flux += difference * weights[bin]
      previous[bin] = spectrum[bin]
    }
    for (let bin = this.fluxBinLimit; bin < previous.length; bin += 1) previous[bin] = spectrum[bin]
    flux /= this.fluxWeightSum

    // Decay the envelope first, then let a trigger overwrite it, so `beat` is
    // exactly 1 on the frame `beatPulse` is true (the Beat CHOP tests both).
    frame.beat *= Math.exp(-delta / BEAT_DECAY_SECONDS)
    if (frame.beat < 1e-4) frame.beat = 0
    frame.beatPulse = false

    if (this.warmup < WARMUP_FRAMES) {
      // The first differences after a start are against an empty spectrum, so
      // they are enormous and would poison the running statistics.
      this.warmup += 1
      return
    }

    let mean = 0
    for (let i = 0; i < this.fluxFilled; i += 1) mean += this.fluxHistory[i]
    mean = this.fluxFilled > 0 ? mean / this.fluxFilled : 0

    let variance = 0
    for (let i = 0; i < this.fluxFilled; i += 1) {
      const deviation = this.fluxHistory[i] - mean
      variance += deviation * deviation
    }
    variance = this.fluxFilled > 1 ? variance / (this.fluxFilled - 1) : 0
    const deviation = Math.sqrt(variance)

    const ready = this.fluxFilled >= FLUX_MIN_HISTORY
    const threshold = Math.max(FLUX_FLOOR, mean + FLUX_THRESHOLD_K * deviation)
    const armed = this.clock - this.lastOnsetAt >= REFRACTORY_SECONDS

    if (ready && armed && flux > threshold) {
      frame.beat = 1
      frame.beatPulse = true
      this.registerOnset()
    }

    // Push after thresholding: comparing the frame against a window that
    // already contains it would raise the bar by its own contribution.
    this.fluxHistory[this.fluxCursor] = flux
    this.fluxCursor = (this.fluxCursor + 1) % FLUX_HISTORY
    if (this.fluxFilled < FLUX_HISTORY) this.fluxFilled += 1

    this.updateTempo()
  }

  private registerOnset(): void {
    const now = this.clock
    const previous = this.lastOnsetAt
    this.lastOnsetAt = now

    const interval = now - previous
    if (!Number.isFinite(interval)) return
    if (interval > BPM_STALE_SECONDS) {
      // A long gap means the previous groove is over; start a fresh history
      // rather than averaging across a break.
      this.intervalCount = 0
      return
    }
    if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) return

    if (this.intervalCount < INTERVAL_HISTORY) {
      this.intervals[this.intervalCount] = interval
      this.intervalCount += 1
      return
    }
    this.intervals.copyWithin(0, 1)
    this.intervals[INTERVAL_HISTORY - 1] = interval
  }

  private updateTempo(): void {
    const frame = this.audioFrame

    if (this.clock - this.lastOnsetAt > BPM_STALE_SECONDS) {
      this.intervalCount = 0
      frame.bpm = 0
      return
    }
    if (this.intervalCount < MIN_INTERVALS_FOR_BPM) {
      if (this.intervalCount === 0) frame.bpm = 0
      return
    }

    const count = this.intervalCount
    const scratch = this.intervalScratch
    for (let i = 0; i < count; i += 1) scratch[i] = foldBpm(60 / this.intervals[i])
    const window = scratch.subarray(0, count)
    window.sort()

    // Median, not mean: onset detection produces occasional doubles and misses,
    // and a single interval that is half or twice the true one would drag a
    // mean badly while barely moving a median.
    const median =
      count % 2 === 1 ? window[(count - 1) / 2] : (window[count / 2 - 1] + window[count / 2]) / 2

    let agreeing = 0
    for (let i = 0; i < count; i += 1) {
      if (Math.abs(window[i] - median) <= median * BPM_AGREEMENT) agreeing += 1
    }
    if (agreeing < Math.ceil(count * BPM_MIN_AGREEING)) {
      // Not a stable pulse (free-time material, or detection is struggling).
      // Better to report "unknown" than to hand the Tempo CHOP a wrong clock.
      frame.bpm = 0
      return
    }

    // Blend rather than jump, so one borderline window does not visibly shift a
    // tempo-locked animation.
    frame.bpm = frame.bpm > 0 ? frame.bpm + (median - frame.bpm) * BPM_BLEND : median
  }

  private decayToSilence(delta: number): void {
    const frame = this.audioFrame
    frame.active = false
    frame.beatPulse = false

    if (this.silenced) return

    frame.level += (0 - frame.level) * poleCoefficient(LEVEL_TAU, delta)
    frame.peak += (0 - frame.peak) * poleCoefficient(PEAK_RELEASE_TAU, delta)
    frame.beat *= Math.exp(-delta / BEAT_DECAY_SECONDS)
    frame.bpm = 0

    if (frame.level < 1e-4 && frame.peak < 1e-4 && frame.beat < 1e-4) {
      frame.level = 0
      frame.peak = 0
      frame.beat = 0
      frame.spectrum.fill(0)
      // Everything is already zero; stop touching 1024 floats every frame.
      this.silenced = true
    }
  }

  bandEnergy(lowHz: number, highHz: number): number {
    const frame = this.audioFrame
    if (!frame.active || frame.sampleRate <= 0) return 0

    const binWidth = frame.sampleRate / frame.fftSize
    if (!Number.isFinite(binWidth) || binWidth <= 0) return 0

    const spectrum = frame.spectrum
    const last = spectrum.length - 1
    const low = Math.min(lowHz, highHz)
    const high = Math.max(lowHz, highHz)

    let first = Math.floor(low / binWidth)
    let final = Math.ceil(high / binWidth)
    if (first < 0) first = 0
    if (first > last) first = last
    if (final > last) final = last
    // A band narrower than one bin still has to read one bin.
    if (final < first) final = first

    let total = 0
    for (let bin = first; bin <= final; bin += 1) total += spectrum[bin]
    return total / (final - first + 1)
  }
}

/**
 * Fold a tempo octave into 70..180 BPM. Onset intervals are ambiguous by
 * factors of two (a half-time kick pattern and a double-time hi-hat describe
 * the same track), and 70..180 is the range a human would name.
 */
function foldBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0
  let folded = bpm
  let guard = 0
  while (folded < BPM_FOLD_LOW && guard < 8) {
    folded *= 2
    guard += 1
  }
  while (folded > BPM_FOLD_HIGH && guard < 16) {
    folded /= 2
    guard += 1
  }
  return folded
}

export const audioEngine: AudioEngine = new WebAudioEngine()
