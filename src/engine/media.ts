/**
 * External media sources.
 *
 * Everything here ends up as a plain 2D texture that the corresponding source
 * operator samples through its normal shader. Frames are copied with
 * `copyExternalImageToTexture` rather than bound as a `texture_external`,
 * because an external texture is invalidated every frame and would force bind
 * groups to be rebuilt per node per frame, and because it cannot be sampled
 * with the same helpers as every other operator. The copy costs one blit and
 * buys uniformity across the whole catalog.
 */

export type MediaStatus = 'idle' | 'loading' | 'ready' | 'error' | 'denied'

export type MediaEntry = {
  nodeId: string
  op: string
  status: MediaStatus
  error: string | null
  width: number
  height: number
  texture: GPUTexture | null
  /** Human-readable description for the inspector and WebMCP source listing. */
  detail: string
}

export type MediaRequest = {
  nodeId: string
  op: string
  params: Record<string, unknown>
  /** Live stream matched to a `remote-in` node by slot, when one has arrived. */
  remoteStream?: MediaStream | null
}

const TEXTURE_USAGE =
  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT

type Slot = {
  nodeId: string
  op: string
  status: MediaStatus
  error: string | null
  detail: string
  texture: GPUTexture | null
  width: number
  height: number
  /** Frame is waiting to be copied into the texture. */
  dirty: boolean

  video: HTMLVideoElement | null
  stream: MediaStream | null
  bitmap: ImageBitmap | null
  canvas: HTMLCanvasElement | null
  frameCallback: number | null

  /** Signature of the inputs that produced the current resource. */
  signature: string
  /** Signature of the last rasterised text, so we only redraw when it changes. */
  rasterSignature: string
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const bool = (value: unknown): boolean => value === true || value === 1

const numOr = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export class MediaRegistry {
  private readonly slots = new Map<string, Slot>()
  private listeners = new Set<() => void>()

  constructor(private readonly device: GPUDevice) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  entries(): MediaEntry[] {
    return Array.from(this.slots.values(), (slot) => ({
      nodeId: slot.nodeId,
      op: slot.op,
      status: slot.status,
      error: slot.error,
      width: slot.width,
      height: slot.height,
      texture: slot.texture,
      detail: slot.detail,
    }))
  }

  get(nodeId: string): MediaEntry | undefined {
    const slot = this.slots.get(nodeId)
    if (!slot) return undefined
    return {
      nodeId,
      op: slot.op,
      status: slot.status,
      error: slot.error,
      width: slot.width,
      height: slot.height,
      texture: slot.texture,
      detail: slot.detail,
    }
  }

  /** Aspect ratio to feed the operator's `sourceAspect` system parameter. */
  aspect(nodeId: string): number {
    const slot = this.slots.get(nodeId)
    if (!slot || !slot.width || !slot.height) return 16 / 9
    return slot.width / slot.height
  }

  /**
   * Reconciles the live media resources with what the graph currently asks for.
   * Called once per frame; all the real work is guarded by signature checks so
   * a steady-state graph does nothing here.
   */
  sync(requests: MediaRequest[]): void {
    const seen = new Set<string>()

    for (const request of requests) {
      seen.add(request.nodeId)
      let slot = this.slots.get(request.nodeId)
      if (!slot) {
        slot = {
          nodeId: request.nodeId,
          op: request.op,
          status: 'idle',
          error: null,
          detail: '',
          texture: null,
          width: 0,
          height: 0,
          dirty: false,
          video: null,
          stream: null,
          bitmap: null,
          canvas: null,
          frameCallback: null,
          signature: '',
          rasterSignature: '',
        }
        this.slots.set(request.nodeId, slot)
      }

      if (slot.op !== request.op) {
        this.teardown(slot)
        slot.op = request.op
        slot.signature = ''
      }

      switch (request.op) {
        case 'camera':
          this.syncCamera(slot, request)
          break
        case 'screen':
          this.syncScreen(slot, request)
          break
        case 'video':
          this.syncVideo(slot, request)
          break
        case 'image':
          this.syncImage(slot, request)
          break
        case 'remote-in':
          this.syncRemote(slot, request)
          break
        case 'text':
          this.syncText(slot, request)
          break
        default:
          break
      }
    }

    for (const [nodeId, slot] of this.slots) {
      if (seen.has(nodeId)) continue
      this.teardown(slot)
      slot.texture?.destroy()
      this.slots.delete(nodeId)
    }
  }

  /** Copies any pending frames into GPU textures. Call once per frame. */
  upload(): void {
    for (const slot of this.slots.values()) {
      const source = slot.video ?? slot.bitmap ?? slot.canvas
      if (!source) continue

      const width = slot.video
        ? slot.video.videoWidth
        : slot.bitmap
          ? slot.bitmap.width
          : (slot.canvas?.width ?? 0)
      const height = slot.video
        ? slot.video.videoHeight
        : slot.bitmap
          ? slot.bitmap.height
          : (slot.canvas?.height ?? 0)

      if (width < 1 || height < 1) continue

      // A camera can change resolution mid-stream (orientation change on a
      // phone), so the texture is reallocated whenever the media size moves.
      if (!slot.texture || slot.texture.width !== width || slot.texture.height !== height) {
        slot.texture?.destroy()
        slot.texture = this.device.createTexture({
          label: `media:${slot.nodeId}`,
          size: { width, height },
          // 8-bit is the right target: camera and video frames arrive as 8-bit
          // and a float texture would triple the bandwidth for no fidelity.
          format: 'rgba8unorm',
          usage: TEXTURE_USAGE,
        })
        slot.width = width
        slot.height = height
        slot.dirty = true
        if (slot.status !== 'ready') {
          slot.status = 'ready'
          this.notify()
        }
      }

      const isVideo = slot.video !== null
      if (isVideo && slot.video!.readyState < 2) continue
      // Videos are re-copied whenever a new frame has been signalled; still
      // images and rasterised text only when marked dirty.
      if (!slot.dirty && !isVideo) continue

      try {
        this.device.queue.copyExternalImageToTexture(
          { source: source as GPUCopyExternalImageSource, flipY: false },
          { texture: slot.texture },
          { width, height },
        )
        slot.dirty = false
      } catch (reason) {
        slot.status = 'error'
        slot.error = reason instanceof Error ? reason.message : 'Frame upload failed.'
        this.notify()
      }
    }
  }

  // ------------------------------------------------------------- camera ----

  private syncCamera(slot: Slot, request: MediaRequest): void {
    const deviceId = str(request.params.deviceId)
    const active = bool(request.params.active)
    const signature = `camera|${deviceId}|${active}`
    if (signature === slot.signature) return
    slot.signature = signature

    this.teardown(slot)
    if (!active) {
      slot.status = 'idle'
      slot.detail = 'Inactive'
      this.notify()
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      slot.status = 'error'
      slot.error = 'This browser cannot open capture devices.'
      this.notify()
      return
    }

    slot.status = 'loading'
    slot.error = null
    slot.detail = 'Opening camera…'
    this.notify()

    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        // The graph may have changed while the permission prompt was open.
        if (slot.signature !== signature) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        this.attachStream(slot, stream, stream.getVideoTracks()[0]?.label || 'Camera')
      })
      .catch((reason: unknown) => {
        if (slot.signature !== signature) return
        const name = reason instanceof DOMException ? reason.name : ''
        slot.status = name === 'NotAllowedError' ? 'denied' : 'error'
        slot.error =
          name === 'NotAllowedError'
            ? 'Camera permission was denied.'
            : reason instanceof Error
              ? reason.message
              : 'Could not open the camera.'
        slot.detail = 'Unavailable'
        this.notify()
      })
  }

  // ------------------------------------------------------------- screen ----

  private syncScreen(slot: Slot, request: MediaRequest): void {
    const active = bool(request.params.active)
    const signature = `screen|${active}`
    if (signature === slot.signature) return
    slot.signature = signature

    if (!active) {
      this.teardown(slot)
      slot.status = 'idle'
      slot.detail = 'Inactive'
      this.notify()
      return
    }

    // `getDisplayMedia` requires transient user activation, which the render
    // loop does not have. The UI calls `requestScreenCapture` from the click
    // handler instead; here we only record that the node is waiting.
    if (!slot.stream) {
      slot.status = 'idle'
      slot.detail = 'Press Choose Source'
      this.notify()
    }
  }

  /** Must be called from a user gesture. */
  async requestScreenCapture(nodeId: string): Promise<void> {
    const slot = this.slots.get(nodeId)
    if (!slot) return
    if (!navigator.mediaDevices?.getDisplayMedia) {
      slot.status = 'error'
      slot.error = 'This browser cannot capture a screen.'
      this.notify()
      return
    }

    try {
      slot.status = 'loading'
      this.notify()
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 } },
        audio: false,
      })
      this.teardown(slot)
      this.attachStream(slot, stream, stream.getVideoTracks()[0]?.label || 'Screen')
    } catch (reason) {
      slot.status = reason instanceof DOMException && reason.name === 'NotAllowedError' ? 'denied' : 'error'
      slot.error = reason instanceof Error ? reason.message : 'Screen capture failed.'
      this.notify()
    }
  }

  // -------------------------------------------------------------- video ----

  private syncVideo(slot: Slot, request: MediaRequest): void {
    const url = str(request.params.file) || str(request.params.url)
    const signature = `video|${url}`

    if (signature !== slot.signature) {
      slot.signature = signature
      this.teardown(slot)

      if (!url) {
        slot.status = 'idle'
        slot.detail = 'No file'
        this.notify()
        return
      }

      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.playsInline = true
      video.preload = 'auto'
      video.src = url
      slot.video = video
      slot.status = 'loading'
      slot.error = null
      slot.detail = 'Loading…'
      this.notify()

      video.addEventListener('loadedmetadata', () => {
        slot.status = 'ready'
        slot.detail = `${video.videoWidth}×${video.videoHeight}`
        this.notify()
      })
      video.addEventListener('error', () => {
        slot.status = 'error'
        slot.error = 'The video could not be loaded. Check the URL or file type.'
        this.notify()
      })
      this.trackFrames(slot, video)
    }

    const video = slot.video
    if (!video) return

    video.loop = bool(request.params.loop)
    video.muted = bool(request.params.muted)
    video.volume = Math.min(1, Math.max(0, numOr(request.params.volume, 1)))

    const speed = numOr(request.params.speed, 1)
    // Negative rates are not supported by browsers; treat them as paused rather
    // than throwing, and let the user know via the detail line.
    const usableSpeed = Math.abs(speed)
    if (usableSpeed > 0.06 && usableSpeed <= 16 && video.playbackRate !== usableSpeed) {
      video.playbackRate = usableSpeed
    }

    if (bool(request.params.cuePulse)) {
      const target = Math.min(1, Math.max(0, numOr(request.params.cue, 0)))
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = target * video.duration
        slot.dirty = true
      }
    }

    const shouldPlay = bool(request.params.play) && speed > 0
    if (shouldPlay && video.paused) void video.play().catch(() => undefined)
    if (!shouldPlay && !video.paused) video.pause()
  }

  // -------------------------------------------------------------- image ----

  private syncImage(slot: Slot, request: MediaRequest): void {
    const url = str(request.params.file) || str(request.params.url)
    const signature = `image|${url}`
    if (signature === slot.signature) return
    slot.signature = signature
    this.teardown(slot)

    if (!url) {
      slot.status = 'idle'
      slot.detail = 'No file'
      this.notify()
      return
    }

    slot.status = 'loading'
    slot.error = null
    this.notify()

    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.blob()
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        if (slot.signature !== signature) {
          bitmap.close()
          return
        }
        slot.bitmap = bitmap
        slot.dirty = true
        slot.status = 'ready'
        slot.detail = `${bitmap.width}×${bitmap.height}`
        this.notify()
      })
      .catch((reason: unknown) => {
        if (slot.signature !== signature) return
        slot.status = 'error'
        slot.error = reason instanceof Error ? reason.message : 'The image could not be loaded.'
        this.notify()
      })
  }

  // ------------------------------------------------------------- remote ----

  private syncRemote(slot: Slot, request: MediaRequest): void {
    const stream = request.remoteStream ?? null
    const signature = `remote|${str(request.params.slot)}|${stream?.id ?? 'none'}`
    if (signature === slot.signature) return
    slot.signature = signature
    this.teardown(slot)

    if (!stream) {
      slot.status = 'idle'
      slot.detail = 'Waiting for a publisher'
      this.notify()
      return
    }

    this.attachStream(slot, stream, 'Remote camera', false)
  }

  // --------------------------------------------------------------- text ----

  private syncText(slot: Slot, request: MediaRequest): void {
    const params = request.params
    const content = str(params.text, '')
    const signature = [
      'text',
      content,
      str(params.fontFamily),
      numOr(params.fontSize, 0.25),
      numOr(params.weight, 700),
      numOr(params.letterSpacing, 0),
      numOr(params.lineHeight, 1.2),
      numOr(params.align, 1),
      bool(params.italic),
      JSON.stringify(params.color),
      JSON.stringify(params.background),
    ].join('|')

    if (signature === slot.rasterSignature) return
    slot.rasterSignature = signature
    slot.signature = signature

    // 1080p gives crisp type even when the frame is scaled up on a projector.
    const height = 1080
    const width = 1920
    const canvas = slot.canvas ?? document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    slot.canvas = canvas

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      slot.status = 'error'
      slot.error = 'A 2D canvas could not be created for text rendering.'
      this.notify()
      return
    }

    const background = toRgba(params.background, [0, 0, 0, 0])
    ctx.clearRect(0, 0, width, height)
    if (background[3] > 0) {
      ctx.fillStyle = cssColor(background)
      ctx.fillRect(0, 0, width, height)
    }

    const size = Math.max(4, numOr(params.fontSize, 0.25) * height)
    const italic = bool(params.italic) ? 'italic ' : ''
    ctx.font = `${italic}${Math.round(numOr(params.weight, 700))} ${size}px ${str(params.fontFamily, 'sans-serif')}`
    ctx.fillStyle = cssColor(toRgba(params.color, [1, 1, 1, 1]))
    ctx.textBaseline = 'middle'
    ctx.letterSpacing = `${numOr(params.letterSpacing, 0) * size}px`

    const alignIndex = Math.round(numOr(params.align, 1))
    ctx.textAlign = alignIndex === 0 ? 'left' : alignIndex === 2 ? 'right' : 'center'
    const x = alignIndex === 0 ? size * 0.4 : alignIndex === 2 ? width - size * 0.4 : width / 2

    const lines = content.split('\n')
    const lineHeight = size * numOr(params.lineHeight, 1.2)
    const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2
    lines.forEach((line, index) => {
      ctx.fillText(line, x, startY + index * lineHeight)
    })

    slot.dirty = true
    slot.status = 'ready'
    slot.detail = `${lines.length} line${lines.length === 1 ? '' : 's'}`
    this.notify()
  }

  // ------------------------------------------------------------- shared ----

  private attachStream(slot: Slot, stream: MediaStream, detail: string, owned = true): void {
    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.autoplay = true
    video.srcObject = stream
    slot.video = video
    slot.stream = owned ? stream : null
    slot.status = 'loading'
    slot.detail = detail

    video.addEventListener('loadedmetadata', () => {
      slot.status = 'ready'
      slot.detail = `${detail} · ${video.videoWidth}×${video.videoHeight}`
      this.notify()
    })

    const track = stream.getVideoTracks()[0]
    track?.addEventListener('ended', () => {
      slot.status = 'idle'
      slot.detail = 'Source ended'
      // Force a re-evaluation next frame so a re-enabled node reopens cleanly.
      slot.signature = ''
      this.notify()
    })

    this.trackFrames(slot, video)
    void video.play().catch(() => undefined)
    this.notify()
  }

  /**
   * Uses `requestVideoFrameCallback` where available so a 30fps camera on a
   * 60fps render loop is only copied thirty times a second.
   */
  private trackFrames(slot: Slot, video: HTMLVideoElement): void {
    type WithFrameCallback = HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }
    const element = video as WithFrameCallback
    if (typeof element.requestVideoFrameCallback !== 'function') {
      // Without the callback we mark every frame dirty and let `upload` copy.
      slot.dirty = true
      return
    }

    const step = () => {
      slot.dirty = true
      if (slot.video === video) {
        slot.frameCallback = element.requestVideoFrameCallback!(step)
      }
    }
    slot.frameCallback = element.requestVideoFrameCallback(step)
  }

  private teardown(slot: Slot): void {
    if (slot.frameCallback !== null && slot.video) {
      const element = slot.video as HTMLVideoElement & {
        cancelVideoFrameCallback?: (handle: number) => void
      }
      element.cancelVideoFrameCallback?.(slot.frameCallback)
    }
    slot.frameCallback = null

    if (slot.video) {
      slot.video.pause()
      slot.video.srcObject = null
      slot.video.removeAttribute('src')
      slot.video.load()
      slot.video = null
    }
    if (slot.stream) {
      for (const track of slot.stream.getTracks()) track.stop()
      slot.stream = null
    }
    slot.bitmap?.close()
    slot.bitmap = null
    slot.dirty = false
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      this.teardown(slot)
      slot.texture?.destroy()
    }
    this.slots.clear()
    this.listeners.clear()
  }
}

function toRgba(value: unknown, fallback: [number, number, number, number]): [number, number, number, number] {
  if (Array.isArray(value) && value.length >= 4) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0, Number(value[3]) || 0]
  }
  return fallback
}

function cssColor([r, g, b, a]: [number, number, number, number]): string {
  const to255 = (channel: number) => Math.round(Math.min(1, Math.max(0, channel)) * 255)
  return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${Math.min(1, Math.max(0, a))})`
}
