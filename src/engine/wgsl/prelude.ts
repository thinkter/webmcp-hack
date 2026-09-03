/**
 * Shared WGSL prelude injected into every generated operator shader.
 *
 * Every texture operator is authored as a fragment body:
 *
 *   fn shade(uv: vec2f) -> vec4f { ... }
 *
 * UV convention: (0,0) is the TOP-LEFT of the frame, (1,1) the bottom-right.
 * This matches `copyExternalImageToTexture` row order, so camera/video/image
 * sources need no flips anywhere in the pipeline.
 */

/** Number of f32 parameter slots available to a single operator. */
export const UNIFORM_FLOATS = 48
/** vec2 res + time + frame + aspect + passIndex + passCount + seed = 32 bytes header. */
export const UNIFORM_HEADER_BYTES = 32
export const UNIFORM_SIZE = UNIFORM_HEADER_BYTES + UNIFORM_FLOATS * 4

/** Bind group slots. Kept explicit so one layout serves every operator. */
export const BINDING = {
  uniforms: 0,
  sampler: 1,
  input0: 2,
  input1: 3,
  input2: 4,
  input3: 5,
  previousPass: 6,
} as const

export const MAX_TEXTURE_INPUTS = 4

export const preludeWGSL = /* wgsl */ `
const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

struct Uniforms {
  res: vec2f,
  time: f32,
  frame: f32,
  aspect: f32,
  // NOTE: "pass" is a WGSL reserved word, hence passIndex.
  passIndex: f32,
  passCount: f32,
  seed: f32,
  p: array<vec4f, 12>,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var T0: texture_2d<f32>;
@group(0) @binding(3) var T1: texture_2d<f32>;
@group(0) @binding(4) var T2: texture_2d<f32>;
@group(0) @binding(5) var T3: texture_2d<f32>;
@group(0) @binding(6) var TP: texture_2d<f32>;

// ---------------------------------------------------------------- inputs ----
fn t0(uv: vec2f) -> vec4f { return textureSample(T0, smp, uv); }
fn t1(uv: vec2f) -> vec4f { return textureSample(T1, smp, uv); }
fn t2(uv: vec2f) -> vec4f { return textureSample(T2, smp, uv); }
fn t3(uv: vec2f) -> vec4f { return textureSample(T3, smp, uv); }
/** Output of the previous pass of this same operator (multi-pass ops). */
fn prev(uv: vec2f) -> vec4f { return textureSample(TP, smp, uv); }

fn tin(index: i32, uv: vec2f) -> vec4f {
  switch index {
    case 0: { return t0(uv); }
    case 1: { return t1(uv); }
    case 2: { return t2(uv); }
    default: { return t3(uv); }
  }
}

// ------------------------------------------------------------- geometry ----
/** Size of one pixel in uv units. */
fn texel() -> vec2f { return 1.0 / U.res; }
/** uv remapped to [-1,1] on Y with X scaled by aspect ratio. */
fn centered(uv: vec2f) -> vec2f { return (uv - 0.5) * vec2f(U.aspect, 1.0) * 2.0; }
fn uncentered(p: vec2f) -> vec2f { return p / (vec2f(U.aspect, 1.0) * 2.0) + 0.5; }
fn rot2(a: f32) -> mat2x2f {
  let c = cos(a); let s = sin(a);
  return mat2x2f(c, -s, s, c);
}

/** Extend modes: 0 = hold edge, 1 = zero/black, 2 = repeat, 3 = mirror. */
fn extendUv(uv: vec2f, mode: i32) -> vec2f {
  switch mode {
    case 2: { return fract(uv); }
    case 3: {
      let m = abs(fract(uv * 0.5) * 2.0 - 1.0);
      return 1.0 - m;
    }
    default: { return clamp(uv, vec2f(0.0), vec2f(1.0)); }
  }
}
fn extendMask(uv: vec2f, mode: i32) -> f32 {
  if mode != 1 { return 1.0; }
  let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return inside;
}

// ---------------------------------------------------------------- colour ----
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let pq = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(pq.xyw, c.r), vec4f(c.r, pq.yzx), step(pq.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let pv = abs(fract(vec3f(c.x) + K.xyz) * 6.0 - vec3f(K.w));
  return c.z * mix(vec3f(K.x), clamp(pv - vec3f(K.x), vec3f(0.0), vec3f(1.0)), c.y);
}

fn srgb2lin(c: vec3f) -> vec3f {
  return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c > vec3f(0.04045));
}
fn lin2srgb(c: vec3f) -> vec3f {
  return select(c * 12.92, 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c > vec3f(0.0031308));
}

/** Premultiply-safe "over" of src on top of dst. */
fn overBlend(dst: vec4f, src: vec4f) -> vec4f {
  let a = src.a + dst.a * (1.0 - src.a);
  if a <= 0.0 { return vec4f(0.0); }
  let rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a;
  return vec4f(rgb, a);
}

/**
 * Blend modes shared by Composite / Cross / Mask style operators.
 * 0 over, 1 add, 2 subtract, 3 multiply, 4 screen, 5 overlay, 6 difference,
 * 7 darken, 8 lighten, 9 dodge, 10 burn, 11 hard light, 12 soft light,
 * 13 exclusion, 14 divide, 15 average.
 */
fn blendRgb(base: vec3f, top: vec3f, mode: i32) -> vec3f {
  switch mode {
    case 1: { return base + top; }
    case 2: { return base - top; }
    case 3: { return base * top; }
    case 4: { return 1.0 - (1.0 - base) * (1.0 - top); }
    case 5: {
      return select(
        2.0 * base * top,
        1.0 - 2.0 * (1.0 - base) * (1.0 - top),
        base > vec3f(0.5)
      );
    }
    case 6: { return abs(base - top); }
    case 7: { return min(base, top); }
    case 8: { return max(base, top); }
    case 9: { return base / max(vec3f(1.0e-4), 1.0 - top); }
    case 10: { return 1.0 - (1.0 - base) / max(vec3f(1.0e-4), top); }
    case 11: {
      return select(
        2.0 * base * top,
        1.0 - 2.0 * (1.0 - base) * (1.0 - top),
        top > vec3f(0.5)
      );
    }
    case 12: {
      return select(
        2.0 * base * top + base * base * (1.0 - 2.0 * top),
        2.0 * base * (1.0 - top) + sqrt(max(base, vec3f(0.0))) * (2.0 * top - 1.0),
        top > vec3f(0.5)
      );
    }
    case 13: { return base + top - 2.0 * base * top; }
    case 14: { return base / max(vec3f(1.0e-4), top); }
    case 15: { return (base + top) * 0.5; }
    default: { return top; }
  }
}

// ----------------------------------------------------------------- noise ----
fn hash11(x: f32) -> f32 { return fract(sin(x * 127.1 + U.seed) * 43758.5453123); }
fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7)) + U.seed) * 43758.5453123);
}
fn hash22(p: vec2f) -> vec2f {
  let k = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3))
  );
  return fract(sin(k + U.seed) * 43758.5453123);
}
fn hash31(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7)) + U.seed) * 43758.5453123);
}

/** Bilinear value noise. */
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** 2D simplex noise in [-1,1]. */
fn snoise(v: vec2f) -> f32 {
  let C = vec4f(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  var i = floor(v + dot(v, C.yy));
  let x0 = v - i + dot(i, C.xx);
  var i1 = vec2f(0.0, 1.0);
  if x0.x > x0.y { i1 = vec2f(1.0, 0.0); }
  var x12 = vec4f(x0.xy, x0.xy) - vec4f(i1, 0.0, 0.0) + vec4f(C.xx, C.zz);
  let pi = i;
  let g0 = hash22(pi) * 2.0 - 1.0;
  let g1 = hash22(pi + i1) * 2.0 - 1.0;
  let g2 = hash22(pi + vec2f(1.0, 1.0)) * 2.0 - 1.0;
  var m = max(vec3f(0.5) - vec3f(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), vec3f(0.0));
  m = m * m; m = m * m;
  let px = vec3f(dot(g0, x0), dot(g1, x12.xy), dot(g2, x12.zw));
  return 70.0 * dot(m, px);
}

/** Fractal Brownian motion built on simplex noise. */
fn fbm(p: vec2f, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  var norm = 0.0;
  for (var o = 0; o < 8; o = o + 1) {
    if o >= octaves { break; }
    sum = sum + amp * snoise(p * freq);
    norm = norm + amp;
    freq = freq * lacunarity;
    amp = amp * gain;
  }
  return sum / max(norm, 1.0e-4);
}

/** Worley / cellular noise. Returns distance to nearest feature point. */
fn worley(p: vec2f) -> f32 {
  let n = floor(p);
  let f = fract(p);
  var best = 1.0e9;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let g = vec2f(f32(x), f32(y));
      let o = hash22(n + g);
      let d = g + o - f;
      best = min(best, dot(d, d));
    }
  }
  return sqrt(best);
}

// ------------------------------------------------------------------ misc ----
fn softStep(edge: f32, softness: f32, x: f32) -> f32 {
  let s = max(softness, 1.0e-4);
  return smoothstep(edge - s, edge + s, x);
}
fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }
fn sdBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let d = abs(p) - b + vec2f(r);
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}
`

export const vertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> VSOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let c = corners[index];
  var out: VSOut;
  out.position = vec4f(c, 0.0, 1.0);
  // Flip Y so uv (0,0) is the top-left of the rendered frame.
  out.uv = c * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return out;
}
`

export const fragmentEntryWGSL = /* wgsl */ `
@fragment
fn fsMain(@location(0) uv: vec2f) -> @location(0) vec4f {
  return shade(uv);
}
`
