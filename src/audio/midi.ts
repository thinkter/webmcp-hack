export type MidiState = 'unsupported' | 'idle' | 'requesting' | 'running' | 'error'

export interface MidiEngine {
  readonly state: MidiState
  readonly error: string | null
  readonly inputs: Array<{ id: string; name: string }>
  /** Most recent CC value, normalised 0..1. channel 0 means "any channel". */
  value(channel: number, controller: number): number
  /** The last controller that moved, for a learn button in the UI. */
  readonly lastTouched: { channel: number; controller: number } | null
  start(): Promise<void>
  stop(): void
  subscribe(listener: () => void): () => void
}

/** MIDI defines 16 channels and 128 controllers per channel. */
const CHANNELS = 16
const CONTROLLERS = 128
const SLOTS = CHANNELS * CONTROLLERS

/** Control Change status bytes are 0xB0..0xBF; the low nibble is the channel. */
const CC_STATUS = 0xb0
const CC_STATUS_MAX = 0xbf

function supportsWebMidi(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
}

function portName(port: { name: string | null; manufacturer: string | null; id: string }): string {
  return port.name ?? port.manufacturer ?? port.id
}

class WebMidiEngine implements MidiEngine {
  /**
   * Flat value table indexed by `channel * 128 + controller`, where `channel`
   * is the raw 0-based wire channel. One typed array beats a Map here: MIDI
   * hardware sends a burst of messages per knob turn, and CC lookups happen
   * several times per render frame.
   */
  private readonly values = new Float32Array(SLOTS)

  /**
   * Which raw channel most recently wrote each controller, so `value(0, cc)`
   * can answer "whatever moved last" without scanning 16 channels. -1 = never.
   */
  private readonly lastChannelFor = new Int8Array(CONTROLLERS).fill(-1)

  private access: MIDIAccess | null = null
  private currentState: MidiState = supportsWebMidi() ? 'idle' : 'unsupported'
  private currentError: string | null = null
  private currentInputs: Array<{ id: string; name: string }> = []
  private currentLastTouched: { channel: number; controller: number } | null = null

  private readonly listeners = new Set<() => void>()
  /** Inputs we have already bound, so re-scanning does not double-subscribe. */
  private readonly bound = new Set<MIDIInput>()
  private pending: Promise<void> | null = null

  private readonly handleMessage = (event: MIDIMessageEvent): void => {
    const data = event.data
    if (!data || data.length < 3) return

    const status = data[0]
    if (status < CC_STATUS || status > CC_STATUS_MAX) return

    const channel = status & 0x0f
    const controller = data[1]
    if (controller >= CONTROLLERS) return

    this.values[channel * CONTROLLERS + controller] = data[2] / 127
    this.lastChannelFor[controller] = channel

    // Reported in the same 1-based convention as value(), see below.
    const touched = this.currentLastTouched
    if (!touched || touched.channel !== channel + 1 || touched.controller !== controller) {
      this.currentLastTouched = { channel: channel + 1, controller }
    }
    // Intentionally no notify(): a single fader sweep is hundreds of messages,
    // and waking React on each one would thrash the whole editor. The CHOP
    // polls value() every frame instead, and a learn UI can poll lastTouched.
  }

  private readonly handleStateChange = (): void => {
    this.rescan()
  }

  get state(): MidiState {
    return this.currentState
  }

  get error(): string | null {
    return this.currentError
  }

  get inputs(): Array<{ id: string; name: string }> {
    return this.currentInputs
  }

  get lastTouched(): { channel: number; controller: number } | null {
    return this.currentLastTouched
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * `channel` is 1-based here, with 0 meaning "any channel", because the MIDI In
   * CHOP exposes channel 0 as a wildcard. So `value(1, cc)` reads wire channel
   * 0 (the one hardware labels "Channel 1"), `value(16, cc)` reads wire channel
   * 15, and `value(0, cc)` returns the value from whichever channel last sent
   * that controller. Anything outside 0..16 returns 0.
   */
  value(channel: number, controller: number): number {
    const cc = Math.round(controller)
    if (!Number.isFinite(cc) || cc < 0 || cc >= CONTROLLERS) return 0

    const requested = Math.round(channel)
    if (!Number.isFinite(requested) || requested < 0 || requested > CHANNELS) return 0

    if (requested === 0) {
      const last = this.lastChannelFor[cc]
      return last < 0 ? 0 : this.values[last * CONTROLLERS + cc]
    }
    return this.values[(requested - 1) * CONTROLLERS + cc]
  }

  start(): Promise<void> {
    if (!supportsWebMidi()) {
      // Firefox without the site permission, Safari, and any insecure context.
      // Not an error the user can act on, so resolve quietly.
      this.setState('unsupported', null)
      return Promise.resolve()
    }
    if (this.currentState === 'running') return Promise.resolve()
    if (this.pending) return this.pending

    const run = this.request()
    this.pending = run
    return run
  }

  private async request(): Promise<void> {
    this.setState('requesting', null)
    try {
      // sysex: false keeps the permission prompt to the mild variant; nothing
      // here needs device-specific system exclusive messages.
      const access = await navigator.requestMIDIAccess({ sysex: false })
      this.access = access
      access.addEventListener('statechange', this.handleStateChange)
      this.setState('running', null)
      this.rescan()
    } catch (cause) {
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : 'MIDI access was denied or is unavailable.'
      this.setState('error', message)
    } finally {
      this.pending = null
    }
  }

  /** Rebuild the input list and bind any newly connected port. */
  private rescan(): void {
    const access = this.access
    if (!access) return

    const seen = new Set<MIDIInput>()
    const next: Array<{ id: string; name: string }> = []

    access.inputs.forEach((input) => {
      seen.add(input)
      if (input.state === 'disconnected') return
      next.push({ id: input.id, name: portName(input) })
      if (!this.bound.has(input)) {
        input.addEventListener('midimessage', this.handleMessage)
        this.bound.add(input)
        // Some ports need an explicit open before they emit; it is a no-op when
        // the implementation has already opened them for us.
        void input.open().catch(() => undefined)
      }
    })

    for (const input of this.bound) {
      if (!seen.has(input)) {
        input.removeEventListener('midimessage', this.handleMessage)
        this.bound.delete(input)
      }
    }

    next.sort((a, b) => a.name.localeCompare(b.name))

    const changed =
      next.length !== this.currentInputs.length ||
      next.some((entry, index) => {
        const previous = this.currentInputs[index]
        return entry.id !== previous.id || entry.name !== previous.name
      })

    if (changed) {
      this.currentInputs = next
      this.notify()
    }
  }

  stop(): void {
    for (const input of this.bound) {
      input.removeEventListener('midimessage', this.handleMessage)
    }
    this.bound.clear()

    if (this.access) {
      this.access.removeEventListener('statechange', this.handleStateChange)
      this.access = null
    }

    this.currentInputs = []
    this.currentLastTouched = null
    // Controller values are deliberately kept: a patch that was driven by a
    // knob should hold its last position rather than snapping to zero when the
    // MIDI layer is torn down.
    this.setState(supportsWebMidi() ? 'idle' : 'unsupported', null)
    this.notify()
  }

  private setState(next: MidiState, error: string | null): void {
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
        console.error('[midi] subscriber threw', cause)
      }
    }
  }
}

export const midiEngine: MidiEngine = new WebMidiEngine()
