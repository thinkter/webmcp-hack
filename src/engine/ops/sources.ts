/**
 * External media sources.
 *
 * Every one of these is uploaded by the engine into a plain 2D texture, which
 * is then bound as `T0` and run through the operator's own shader. That means
 * framing, flipping and letterboxing are handled by ordinary WGSL rather than
 * by special cases in the renderer, and a camera behaves exactly like a video
 * file or a rasterised text layer from the graph's point of view.
 */

import { BOOL, COLOR, DEVICE, F, FILE, MENU, TEXT, top, type ParamDraft, type OperatorSpec } from './kit'

/**
 * `sourceAspect` is written by the engine each frame from the real dimensions
 * of the underlying media, so the shader can letterbox correctly.
 */
const framingParams = (): ParamDraft[] => [
  MENU('fit', 'Fit', 0, ['Fill', 'Fit', 'Stretch'], { page: 'Framing' }),
  BOOL('flipX', 'Flip X', false, { page: 'Framing' }),
  BOOL('flipY', 'Flip Y', false, { page: 'Framing' }),
  F('zoom', 'Zoom', 1, 0.1, 4, { page: 'Framing' }),
  F('offsetX', 'Offset X', 0, -1, 1, { page: 'Framing' }),
  F('offsetY', 'Offset Y', 0, -1, 1, { page: 'Framing' }),
  COLOR('background', 'Background', [0, 0, 0, 0], { page: 'Framing' }),
  F('sourceAspect', 'Source Aspect', 1.7777778, 0.01, 100, { system: true }),
]

/**
 * Shared body for every external source. Expects `T0` to hold the uploaded
 * media and the framing parameters above to be present.
 */
const framingShader = /* wgsl */ `
fn src_frame(uv: vec2f) -> vec2f {
  let sa = max(p_sourceAspect(), 1.0e-3);
  let fa = max(U.aspect, 1.0e-3);
  var s = uv - 0.5;

  // Fill crops the long axis, Fit letterboxes it, Stretch ignores aspect.
  switch p_fitI() {
    case 1: {
      if sa > fa { s.y = s.y * (sa / fa); } else { s.x = s.x * (fa / sa); }
    }
    case 2: {}
    default: {
      if sa > fa { s.x = s.x * (fa / sa); } else { s.y = s.y * (sa / fa); }
    }
  }

  s = s / max(p_zoom(), 1.0e-3);
  s = s - vec2f(p_offsetX(), p_offsetY());
  s = s * vec2f(select(1.0, -1.0, p_flipXB()), select(1.0, -1.0, p_flipYB()));
  return s + 0.5;
}

fn shade(uv: vec2f) -> vec4f {
  let s = src_frame(uv);
  let inside = step(0.0, s.x) * step(s.x, 1.0) * step(0.0, s.y) * step(s.y, 1.0);
  let sampled = t0(clamp(s, vec2f(0.0), vec2f(1.0)));
  return mix(p_background(), sampled, inside);
}
`

const camera = top({
  id: 'camera',
  label: 'Camera',
  category: 'source',
  runtime: 'external',
  description: 'Live webcam feed from a local capture device.',
  td: 'Video Device In TOP',
  keywords: ['webcam', 'video in', 'capture', 'live', 'getusermedia'],
  inputs: [],
  params: [
    DEVICE('deviceId', 'Device'),
    BOOL('active', 'Active', true, { help: 'Releases the camera when turned off.' }),
    ...framingParams(),
  ],
  shader: framingShader,
})

const screenCapture = top({
  id: 'screen',
  label: 'Screen Capture',
  category: 'source',
  runtime: 'external',
  description: 'Captures a screen, window, or browser tab as a live texture.',
  td: 'Screen Grab TOP',
  keywords: ['display', 'window', 'desktop', 'share', 'getdisplaymedia'],
  inputs: [],
  params: [
    BOOL('active', 'Active', false, { help: 'Prompts for a capture target when enabled.' }),
    ...framingParams(),
  ],
  shader: framingShader,
})

const video = top({
  id: 'video',
  label: 'Video File',
  category: 'source',
  runtime: 'external',
  description: 'Plays a video file or URL with transport and speed control.',
  td: 'Movie File In TOP',
  keywords: ['movie', 'clip', 'file', 'playback', 'mp4', 'webm'],
  inputs: [],
  params: [
    FILE('file', 'File', { help: 'Drop a video file, or use the URL below.' }),
    TEXT('url', 'URL', ''),
    BOOL('play', 'Play', true),
    BOOL('loop', 'Loop', true),
    BOOL('muted', 'Muted', true),
    F('speed', 'Speed', 1, -4, 4),
    F('volume', 'Volume', 1, 0, 1),
    F('cue', 'Cue Position', 0, 0, 1, {
      help: 'Scrubs to a normalised position when Cue is pulsed.',
    }),
    BOOL('cuePulse', 'Cue', false, { help: 'Turn on to seek to the cue position.' }),
    ...framingParams(),
  ],
  shader: framingShader,
})

const image = top({
  id: 'image',
  label: 'Image',
  category: 'source',
  runtime: 'external',
  description: 'Loads a still image from a file or URL.',
  td: 'Movie File In TOP',
  keywords: ['picture', 'photo', 'png', 'jpg', 'still', 'texture'],
  inputs: [],
  params: [FILE('file', 'File'), TEXT('url', 'URL', ''), ...framingParams()],
  shader: framingShader,
})

const remoteIn = top({
  id: 'remote-in',
  label: 'Remote Camera',
  category: 'source',
  runtime: 'external',
  description: 'Receives a live WebRTC stream published by a phone or another machine.',
  td: 'Video Stream In TOP',
  keywords: ['webrtc', 'phone', 'stream', 'qr', 'remote', 'network'],
  inputs: [],
  params: [
    TEXT('slot', 'Slot', 'cam-1', {
      help: 'Publishers joining with this slot name feed this operator.',
    }),
    ...framingParams(),
  ],
  shader: framingShader,
})

const text = top({
  id: 'text',
  label: 'Text',
  category: 'generator',
  runtime: 'raster',
  description: 'Rasterises styled text into a texture on the CPU.',
  td: 'Text TOP',
  keywords: ['type', 'font', 'caption', 'title', 'label', 'lyrics'],
  inputs: [],
  params: [
    TEXT('text', 'Text', 'HELLO'),
    TEXT('fontFamily', 'Font', 'Inter, system-ui, sans-serif'),
    F('fontSize', 'Size', 0.25, 0.01, 1, { help: 'As a fraction of frame height.' }),
    F('weight', 'Weight', 700, 100, 900, { step: 100 }),
    F('letterSpacing', 'Letter Spacing', 0, -0.2, 0.5),
    F('lineHeight', 'Line Height', 1.2, 0.5, 3),
    MENU('align', 'Align', 1, ['Left', 'Centre', 'Right']),
    BOOL('italic', 'Italic', false),
    COLOR('color', 'Colour', [1, 1, 1, 1]),
    COLOR('background', 'Background', [0, 0, 0, 0]),
    ...framingParams().filter((param) => param.key !== 'background'),
  ],
  shader: framingShader,
})

const nullOp = top({
  id: 'null',
  label: 'Null',
  category: 'filter',
  runtime: 'shader',
  description: 'Passes its input straight through. Useful as a stable wiring anchor.',
  td: 'Null TOP',
  keywords: ['passthrough', 'anchor', 'reference', 'bus'],
  inputs: ['Texture'],
  params: [],
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f { return t0(uv); }
`,
})

export const sourceOperators: OperatorSpec[] = [
  camera,
  remoteIn,
  screenCapture,
  video,
  image,
  text,
  nullOp,
]

/** Operator ids whose pixels come from an uploaded `HTMLVideoElement`-like source. */
export const EXTERNAL_SOURCE_IDS = new Set(['camera', 'screen', 'video', 'image', 'remote-in'])
