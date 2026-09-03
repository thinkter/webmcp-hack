/**
 * Terminal operators.
 *
 * An output node does not allocate a texture of its own. Instead the engine
 * runs its shader directly into whatever display surfaces are subscribed to it
 * — the program monitor, a node thumbnail, a projector window on another
 * machine — so the same grade is applied everywhere the signal lands.
 */

import { BOOL, COLOR, F, MENU, TEXT, top, type OperatorSpec } from './kit'

/** Display grade shared by every output surface. */
const displayShader = /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  var c = t0(uv);

  c = vec4f(c.rgb * exp2(p_exposure()), c.a);

  // Gamma and contrast are applied in display space, after exposure, so the
  // controls behave the way a lighting operator expects on a projector.
  let g = max(p_gamma(), 1.0e-3);
  let sign = sign(c.rgb);
  c = vec4f(sign * pow(abs(c.rgb), vec3f(1.0 / g)), c.a);

  c = vec4f((c.rgb - 0.5) * p_contrast() + 0.5, c.a);
  c = vec4f(mix(vec3f(luma(c.rgb)), c.rgb, p_saturation()), c.a);

  if p_testPatternB() {
    // A thin safe-area frame plus a centre cross, for lining up a projector.
    let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let border = 1.0 - smoothstep(0.048, 0.052, edge);
    let cross = max(
      1.0 - smoothstep(0.0, 0.0015, abs(uv.x - 0.5)),
      1.0 - smoothstep(0.0, 0.0015, abs(uv.y - 0.5))
    );
    c = vec4f(mix(c.rgb, vec3f(0.0, 1.0, 0.6), max(border, cross) * 0.85), max(c.a, border));
  }

  let t = p_tint();
  return vec4f(clamp(c.rgb * t.rgb, vec3f(0.0), vec3f(64.0)), clamp(c.a * t.a, 0.0, 1.0));
}
`

const gradeParams = [
  F('exposure', 'Exposure', 0, -4, 4, { help: 'In stops.' }),
  F('gamma', 'Gamma', 1, 0.1, 4),
  F('contrast', 'Contrast', 1, 0, 3),
  F('saturation', 'Saturation', 1, 0, 3),
  COLOR('tint', 'Tint', [1, 1, 1, 1]),
  BOOL('testPattern', 'Test Pattern', false, {
    help: 'Overlays a safe-area frame and centre cross for alignment.',
  }),
]

const out = top({
  id: 'out',
  label: 'Out',
  category: 'output',
  runtime: 'output',
  description: 'Sends the signal to the program monitor and any attached display.',
  td: 'Out TOP',
  keywords: ['preview', 'program', 'monitor', 'display', 'render', 'master'],
  inputs: ['Texture'],
  params: [TEXT('name', 'Name', 'Program'), ...gradeParams],
  shader: displayShader,
})

const remoteOut = top({
  id: 'remote-out',
  label: 'Remote Out',
  category: 'output',
  runtime: 'output',
  description: 'Publishes the signal to a shareable /output link for a projector or second screen.',
  td: 'Video Stream Out TOP',
  keywords: ['projector', 'stream', 'second screen', 'broadcast', 'send', 'wall'],
  inputs: ['Texture'],
  params: [
    TEXT('slot', 'Slot', 'main', {
      help: 'Display clients opening /output/<slot> render this signal.',
    }),
    MENU('resolution', 'Resolution', 1, ['1280 × 720', '1920 × 1080', 'Match Display']),
    ...gradeParams,
  ],
  shader: displayShader,
})

export const outputOperators: OperatorSpec[] = [out, remoteOut]

/** The display grade parameters an output surface understands. */
export const OUTPUT_IDS = new Set(outputOperators.map((operator) => operator.id))
