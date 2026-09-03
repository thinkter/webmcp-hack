/**
 * Feedback and user-authored WGSL.
 *
 * These two operators are what turn the tool from a fixed effects rack into
 * something open-ended: `feedback` breaks the acyclic constraint so trails and
 * reaction-diffusion loops become possible, and `glsl` lets a user drop in
 * their own shader without touching the codebase.
 */

import { BOOL, F, INT, WGSL, top, type OperatorSpec } from './kit'

const feedback = top({
  id: 'feedback',
  label: 'Feedback',
  category: 'composite',
  runtime: 'delay',
  description: "Outputs the previous frame of whatever is wired into it, so loops are legal.",
  td: 'Feedback TOP',
  keywords: ['trails', 'delay', 'loop', 'echo', 'recursive', 'history', 'smear'],
  inputs: [
    {
      id: 'in-0',
      label: 'Loop',
      type: 'texture',
      // Read from last frame, so this edge is excluded from cycle detection.
      // That is exactly what makes `A -> B -> Feedback -> A` a valid patch.
      delayed: true,
    },
  ],
  params: [
    F('decay', 'Decay', 0, 0, 1, { help: 'Fades the retained frame toward black.' }),
    F('shrink', 'Shrink', 0, -0.2, 0.2, {
      help: 'Scales the retained frame each pass, producing zoom trails.',
    }),
    F('rotate', 'Rotate', 0, -0.05, 0.05, { help: 'Full turns applied per frame.' }),
    F('hueShift', 'Hue Shift', 0, -0.1, 0.1),
    BOOL('reset', 'Reset', false, { help: 'Clears the stored frame while enabled.' }),
  ],
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  // The engine binds T0 to the copy of last frame's signal.
  var p = uv - 0.5;
  p = rot2(p_rotate() * TAU) * p;
  p = p * (1.0 - p_shrink());
  let s = p + 0.5;

  let inside = step(0.0, s.x) * step(s.x, 1.0) * step(0.0, s.y) * step(s.y, 1.0);
  var c = t0(clamp(s, vec2f(0.0), vec2f(1.0))) * inside;

  if abs(p_hueShift()) > 1.0e-5 {
    var hsv = rgb2hsv(max(c.rgb, vec3f(0.0)));
    hsv.x = fract(hsv.x + p_hueShift());
    c = vec4f(hsv2rgb(hsv), c.a);
  }

  let keep = 1.0 - p_decay();
  return select(c * keep, vec4f(0.0), p_resetB());
}
`,
})

const DEFAULT_USER_WGSL = `// Runs once per pixel. Return the final colour.
//
// Available: t0(uv)..t3(uv), texel(), centered(uv), U.time, U.res, U.aspect
//            k0()..k7() are the eight sliders below
//            snoise(p), fbm(p, octaves, lacunarity, gain), worley(p)
//            rgb2hsv, hsv2rgb, luma, rot2, blendRgb, PI, TAU

fn shade(uv: vec2f) -> vec4f {
  let warp = vec2f(
    snoise(uv * 4.0 + U.time * 0.2),
    snoise(uv * 4.0 - U.time * 0.2)
  ) * k0() * 0.1;

  var c = t0(uv + warp);

  let bands = sin((uv.y + U.time * k1()) * TAU * 40.0) * 0.5 + 0.5;
  c = vec4f(c.rgb * mix(1.0, bands, k2()), c.a);

  return c;
}
`

const customWgsl = top({
  id: 'glsl',
  label: 'Custom WGSL',
  category: 'filter',
  runtime: 'custom',
  description: 'Compile your own WGSL fragment shader at runtime against up to four inputs.',
  td: 'GLSL TOP',
  keywords: ['shader', 'wgsl', 'code', 'glsl', 'custom', 'script', 'programmable'],
  inputs: ['Input 1', 'Input 2', 'Input 3', 'Input 4'],
  params: [
    WGSL('source', 'Shader', DEFAULT_USER_WGSL),
    F('k0', 'Slider 0', 0.5, 0, 1, { page: 'Uniforms' }),
    F('k1', 'Slider 1', 0.2, 0, 1, { page: 'Uniforms' }),
    F('k2', 'Slider 2', 0.3, 0, 1, { page: 'Uniforms' }),
    F('k3', 'Slider 3', 0, 0, 1, { page: 'Uniforms' }),
    F('k4', 'Slider 4', 0, 0, 1, { page: 'Uniforms' }),
    F('k5', 'Slider 5', 0, 0, 1, { page: 'Uniforms' }),
    F('k6', 'Slider 6', 0, 0, 1, { page: 'Uniforms' }),
    F('k7', 'Slider 7', 0, 0, 1, { page: 'Uniforms' }),
    INT('passes', 'Passes', 1, 1, 4, {
      page: 'Uniforms',
      help: 'Re-runs the shader, exposing the previous result through prev(uv).',
    }),
  ],
  // Replaced at runtime by the user's source; this is the compiled fallback
  // used before the first successful compile and after a compile error.
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f { return t0(uv); }
`,
})

export const customOperators: OperatorSpec[] = [feedback, customWgsl]

export { DEFAULT_USER_WGSL }
