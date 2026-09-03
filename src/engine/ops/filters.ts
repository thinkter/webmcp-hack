/**
 * Filter operators: single-input image processors.
 *
 * Every shader body here defines `fn shade(uv: vec2f) -> vec4f` and reads its
 * parameters through the generated `p_<key>()` accessors. Shared conventions:
 *
 * - uv (0,0) is the top-left of the frame.
 * - Colour is non-premultiplied and only loosely bounded to 0..1, so anything
 *   that would break on negative or >1 values (gamma, HSV) is guarded.
 * - Helper functions are prefixed with the operator id so a reader can tell at
 *   a glance which shader owns them.
 * - Per-pixel decisions are made with `mix`/`select`/`step` rather than `if`,
 *   both for speed and because `textureSample` may not appear in non-uniform
 *   control flow. Branches that *do* exist are always on uniform values
 *   (parameters, `U.passIndex`), which keeps texture sampling legal inside them.
 */

import { BOOL, COLOR, F, INT, MENU, top, type OperatorSpec } from './kit'

/**
 * Separable gaussian, used for both passes of `blur`. Pass 0 runs horizontally
 * over the graph input, pass 1 runs vertically over pass 0's result, which
 * turns an O(n^2) kernel into 2 * O(n).
 */
const BLUR_SHADER = /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let radius = max(p_radius(), 0.0);
  let taps = max(p_qualityI(), 1);
  let tx = texel();

  // U.passIndex is uniform, so branching on it is uniform control flow and texture
  // sampling inside the branches is legal.
  let vertical = U.passIndex > 0.5;
  let dir = select(vec2f(tx.x, 0.0), vec2f(0.0, tx.y), vertical);

  // Taps are spread evenly across the radius; sigma = radius/2 puts the
  // requested radius at ~2 sigma, where a gaussian has decayed to ~13%.
  let sigma = max(radius * 0.5, 1.0e-4);
  let stride = radius / f32(taps);
  let inv2s2 = 1.0 / (2.0 * sigma * sigma);

  var sum = vec4f(0.0);
  var wsum = 0.0;

  // The two source textures differ per pass, so the loop is written twice
  // rather than sampling both textures on every tap.
  if vertical {
    sum = prev(uv);
    wsum = 1.0;
    for (var i = 1; i <= 24; i = i + 1) {
      if i > taps { break; }
      let d = f32(i) * stride;
      let w = exp(-d * d * inv2s2);
      let o = dir * d;
      sum = sum + (prev(uv + o) + prev(uv - o)) * w;
      wsum = wsum + 2.0 * w;
    }
  } else {
    sum = t0(uv);
    wsum = 1.0;
    for (var i = 1; i <= 24; i = i + 1) {
      if i > taps { break; }
      let d = f32(i) * stride;
      let w = exp(-d * d * inv2s2);
      let o = dir * d;
      sum = sum + (t0(uv + o) + t0(uv - o)) * w;
      wsum = wsum + 2.0 * w;
    }
  }

  let blurred = sum / max(wsum, 1.0e-6);
  // Dry/wet mix only makes sense once both axes have run.
  return select(blurred, mix(t0(uv), blurred, p_amount()), vertical);
}
`

/**
 * Bloom's blur passes (1 = horizontal, 2 = vertical). A fixed 9-tap kernel is
 * enough because it runs at half resolution on an already smooth bright-pass.
 */
const BLOOM_BLUR_SHADER = /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let dir = select(vec2f(1.0, 0.0), vec2f(0.0, 1.0), U.passIndex > 1.5);
  // Offsets are spread over radius/4 so the outermost tap lands on the radius.
  let base = texel() * dir * max(p_radius(), 0.0) * 0.25;

  // Normalised 9-tap gaussian (sigma ~= 2 taps); weights already sum to 1.
  var w = array<f32, 5>(0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);

  var acc = prev(uv).rgb * w[0];
  for (var i = 1; i < 5; i = i + 1) {
    let o = base * f32(i);
    acc = acc + (prev(uv + o).rgb + prev(uv - o).rgb) * w[i];
  }
  return vec4f(acc, 1.0);
}
`

export const filterOperators: OperatorSpec[] = [
  top({
    id: 'level',
    label: 'Level',
    category: 'filter',
    runtime: 'shader',
    description:
      'Adjusts brightness, contrast, gamma, saturation, hue and black/white input levels of an image.',
    td: 'Level TOP',
    keywords: ['brightness', 'contrast', 'gamma', 'saturation', 'hue', 'exposure', 'colour correct'],
    inputs: ['Texture'],
    params: [
      F('blackLevel', 'Black Level', 0, -1, 1, { page: 'Range' }),
      F('whiteLevel', 'White Level', 1, 0, 2, { page: 'Range' }),
      F('gamma', 'Gamma', 1, 0.1, 4, { page: 'Range' }),
      F('brightness', 'Brightness', 1, 0, 4, { page: 'Range' }),
      F('contrast', 'Contrast', 1, 0, 4, { page: 'Range' }),
      F('saturation', 'Saturation', 1, 0, 3, { page: 'Colour' }),
      F('hueShift', 'Hue Shift', 0, -0.5, 0.5, { page: 'Colour', unit: 'turns' }),
      F('opacity', 'Opacity', 1, 0, 1, { page: 'Output', help: 'Scales alpha.' }),
      BOOL('invert', 'Invert', false, { page: 'Output' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  var c = src.rgb;

  // Input range first: this is the "what counts as black/white" stage, so
  // everything after it operates on a normalised signal.
  let lo = p_blackLevel();
  let hi = p_whiteLevel();
  c = (c - vec3f(lo)) / max(hi - lo, 1.0e-4);

  // Gamma on magnitude only. Textures are rgba16float and may legitimately
  // hold negatives; pow() of a negative base is undefined, so mirror it.
  let g = 1.0 / max(p_gamma(), 1.0e-3);
  c = sign(c) * pow(abs(c), vec3f(g));

  c = (c - vec3f(0.5)) * p_contrast() + vec3f(0.5);
  c = c * p_brightness();

  c = mix(vec3f(luma(c)), c, p_saturation());

  // HSV is only meaningful for non-negative RGB, so the rotated result is
  // faded in by how much shift was actually asked for. At shift 0 the original
  // (possibly out-of-gamut) colour survives untouched.
  let shift = p_hueShift();
  var hsv = rgb2hsv(max(c, vec3f(0.0)));
  hsv.x = fract(hsv.x + shift + 1.0);
  c = mix(c, hsv2rgb(hsv), step(1.0e-5, abs(shift)));

  c = mix(c, vec3f(1.0) - c, p_invert());

  return vec4f(c, src.a * p_opacity());
}
`,
  }),

  top({
    id: 'blur',
    label: 'Blur',
    category: 'filter',
    runtime: 'shader',
    description:
      'Two-pass separable gaussian blur with a pixel radius, tap count for quality, and a mix back to the unblurred image.',
    td: 'Blur TOP',
    keywords: ['gaussian', 'soften', 'defocus', 'smooth', 'blur'],
    inputs: ['Texture'],
    params: [
      F('radius', 'Radius', 8, 0, 64, { page: 'Blur', unit: 'px' }),
      INT('quality', 'Taps', 8, 1, 24, { page: 'Blur', help: 'Samples per side, per axis.' }),
      F('amount', 'Amount', 1, 0, 1, { page: 'Blur' }),
    ],
    passes: [
      { shader: BLUR_SHADER, label: 'Horizontal' },
      { shader: BLUR_SHADER, label: 'Vertical' },
    ],
  }),

  top({
    id: 'sharpen',
    label: 'Sharpen',
    category: 'filter',
    runtime: 'shader',
    description: 'Unsharp mask that boosts local detail by subtracting a small blur from the image.',
    td: 'Sharpen TOP',
    keywords: ['unsharp', 'crisp', 'detail', 'clarity', 'edge enhance'],
    inputs: ['Texture'],
    params: [
      F('radius', 'Radius', 1, 0, 8, { page: 'Sharpen', unit: 'px' }),
      F('amount', 'Amount', 1, 0, 5, { page: 'Sharpen' }),
    ],
    shader: /* wgsl */ `
/**
 * 3x3 tent kernel with the ring pushed r pixels out. Moving the taps rather
 * than widening a kernel means the radius changes the halo size at a fixed cost.
 */
fn sharpen_soft(uv: vec2f, r: vec2f) -> vec3f {
  var acc = t0(uv).rgb * 4.0;
  acc = acc + (t0(uv + vec2f( r.x, 0.0)).rgb
             + t0(uv + vec2f(-r.x, 0.0)).rgb
             + t0(uv + vec2f(0.0,  r.y)).rgb
             + t0(uv + vec2f(0.0, -r.y)).rgb) * 2.0;
  acc = acc + (t0(uv + vec2f( r.x,  r.y)).rgb
             + t0(uv + vec2f( r.x, -r.y)).rgb
             + t0(uv + vec2f(-r.x,  r.y)).rgb
             + t0(uv + vec2f(-r.x, -r.y)).rgb);
  return acc / 16.0;
}

fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  let r = texel() * max(p_radius(), 0.0);
  let soft = sharpen_soft(uv, r);
  // Classic unsharp: original + amount * (original - blurred).
  let sharp = src.rgb + (src.rgb - soft) * p_amount();
  return vec4f(sharp, src.a);
}
`,
  }),

  top({
    id: 'edge',
    label: 'Edge',
    category: 'filter',
    runtime: 'shader',
    description:
      'Sobel edge detector that can output edges alone, edges added over the source, or a tangent-space normal map.',
    td: 'Edge TOP',
    keywords: ['sobel', 'outline', 'contour', 'gradient', 'normal map', 'emboss'],
    inputs: ['Texture'],
    params: [
      F('strength', 'Strength', 1, 0, 8, { page: 'Edge' }),
      F('threshold', 'Threshold', 0, 0, 1, { page: 'Edge' }),
      MENU('mode', 'Output', 0, ['Edges', 'Edges on Source', 'Normals'], { page: 'Edge' }),
      BOOL('colour', 'Colour Edges', false, {
        page: 'Edge',
        help: 'Off runs Sobel on luminance only.',
      }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let tx = texel();
  let src = t0(uv);

  // Sampled unconditionally into locals: every branch below is a uniform menu
  // test, but keeping the taps outside them also avoids redundant fetches.
  let tl = t0(uv + tx * vec2f(-1.0, -1.0)).rgb;
  let tc = t0(uv + tx * vec2f( 0.0, -1.0)).rgb;
  let tr = t0(uv + tx * vec2f( 1.0, -1.0)).rgb;
  let ml = t0(uv + tx * vec2f(-1.0,  0.0)).rgb;
  let mr = t0(uv + tx * vec2f( 1.0,  0.0)).rgb;
  let bl = t0(uv + tx * vec2f(-1.0,  1.0)).rgb;
  let bc = t0(uv + tx * vec2f( 0.0,  1.0)).rgb;
  let br = t0(uv + tx * vec2f( 1.0,  1.0)).rgb;

  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);

  let strength = p_strength();
  let magRgb = sqrt(gx * gx + gy * gy) * strength;

  // luma() is a linear combination, so the luma of a gradient equals the
  // gradient of luma; no extra taps are needed for the monochrome path.
  let lgx = luma(gx);
  let lgy = luma(gy);
  let magLum = sqrt(lgx * lgx + lgy * lgy) * strength;

  let mag = mix(vec3f(magLum), magRgb, p_colour());

  // A soft gate instead of a hard step: thin one-pixel edges would otherwise
  // alias badly as the threshold sweeps past them.
  let thr = p_threshold();
  let gate = smoothstep(vec3f(thr), vec3f(thr + 0.05), mag);
  let edges = mag * gate;

  // Y grows downward in uv space, so d(luma)/d(y_up) = -lgy; a green-up
  // (OpenGL style) normal therefore takes +lgy directly.
  let normal = normalize(vec3f(-lgx * strength, lgy * strength, 1.0)) * 0.5 + vec3f(0.5);

  var rgb = edges;
  var a = src.a;
  switch p_modeI() {
    case 1: { rgb = src.rgb + edges; }
    case 2: { rgb = normal; a = 1.0; }
    default: {}
  }
  return vec4f(rgb, a);
}
`,
  }),

  top({
    id: 'bloom',
    label: 'Bloom',
    category: 'filter',
    runtime: 'shader',
    description:
      'Extracts bright areas, blurs them at half resolution, and adds the glow back over the original image.',
    td: 'Luma Blur TOP',
    keywords: ['glow', 'luma blur', 'bright pass', 'halation', 'light bleed'],
    inputs: ['Texture'],
    params: [
      F('threshold', 'Threshold', 0.7, 0, 2, { page: 'Bloom' }),
      F('knee', 'Softness', 0.3, 0.001, 1, { page: 'Bloom', help: 'Width of the knee.' }),
      F('radius', 'Radius', 16, 0, 64, { page: 'Bloom', unit: 'px' }),
      F('intensity', 'Intensity', 1, 0, 4, { page: 'Bloom' }),
    ],
    passes: [
      {
        label: 'Bright Pass',
        // Half resolution: the bright-pass is about to be heavily blurred, so
        // the detail thrown away here is never missed.
        scale: 0.5,
        shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let c = t0(uv);
  let l = max(luma(c.rgb), 0.0);
  let thr = p_threshold();
  let knee = max(p_knee(), 1.0e-4);

  // Quadratic knee: a hard threshold makes bloom pop on as luminance crosses
  // it, which flickers badly on moving footage. This ramps in smoothly.
  var soft = clamp(l - thr + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  let contrib = max(soft, l - thr) / max(l, 1.0e-4);

  return vec4f(max(c.rgb, vec3f(0.0)) * contrib, 1.0);
}
`,
      },
      { label: 'Bloom Blur H', scale: 0.5, shader: BLOOM_BLUR_SHADER },
      { label: 'Bloom Blur V', scale: 0.5, shader: BLOOM_BLUR_SHADER },
      {
        label: 'Composite',
        shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  // prev() is the half-res blur; the sampler upscales it bilinearly, which is
  // acceptable because it holds no frequencies above the half-res Nyquist.
  let glow = max(prev(uv).rgb, vec3f(0.0)) * p_intensity();
  return vec4f(src.rgb + glow, src.a);
}
`,
      },
    ],
  }),

  top({
    id: 'pixelate',
    label: 'Pixelate',
    category: 'filter',
    runtime: 'shader',
    description:
      'Snaps the image to a grid of blocks with independent X/Y cell sizes and an optional dot or cross mask inside each cell.',
    td: 'Resolution TOP',
    keywords: ['mosaic', 'blocks', 'lowres', 'dots', 'quantize', 'lego'],
    inputs: ['Texture'],
    params: [
      F('sizeX', 'Pixel Size X', 8, 1, 256, { page: 'Grid', unit: 'px' }),
      F('sizeY', 'Pixel Size Y', 8, 1, 256, { page: 'Grid', unit: 'px' }),
      BOOL('link', 'Link X/Y', true, { page: 'Grid' }),
      MENU('shape', 'Shape', 0, ['Square', 'Round', 'Cross'], { page: 'Grid' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let sx = max(p_sizeX(), 1.0);
  let sy = select(max(p_sizeY(), 1.0), sx, p_linkB());
  let cell = vec2f(sx, sy) / U.res;

  let idx = floor(uv / cell);
  // Sample the cell centre so the block colour is stable as uv moves inside it.
  let c = t0((idx + vec2f(0.5)) * cell);

  // Cell-local coordinates in -1..1, used for the shape mask.
  let local = (uv - idx * cell) / cell * 2.0 - vec2f(1.0);

  let dotMask = 1.0 - smoothstep(0.78, 1.0, length(local));
  let barH = 1.0 - smoothstep(0.30, 0.42, abs(local.y));
  let barV = 1.0 - smoothstep(0.30, 0.42, abs(local.x));
  let plusMask = max(barH, barV);

  var mask = 1.0;
  switch p_shapeI() {
    case 1: { mask = dotMask; }
    case 2: { mask = plusMask; }
    default: {}
  }

  // RGB is masked as well as alpha so the shape still reads when the result is
  // viewed or composited over black rather than through its matte.
  return vec4f(c.rgb * mask, c.a * mask);
}
`,
  }),

  top({
    id: 'posterize',
    label: 'Posterize',
    category: 'filter',
    runtime: 'shader',
    description:
      'Quantizes each channel to a fixed number of levels, with optional ordered dithering to hide the banding.',
    td: 'Level TOP',
    keywords: ['quantize', 'banding', 'steps', 'dither', 'bayer', 'flatten'],
    inputs: ['Texture'],
    params: [
      INT('levels', 'Levels', 6, 2, 32, { page: 'Quantize' }),
      BOOL('dither', 'Dither', false, { page: 'Quantize' }),
      F('ditherAmount', 'Dither Amount', 1, 0, 2, { page: 'Quantize' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  let steps = f32(clamp(p_levelsI(), 2, 32)) - 1.0;

  // 4x4 Bayer matrix. An ordered threshold pattern beats white-noise dither
  // here because it is temporally stable, so still frames do not fizz.
  var bayer = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  let pix = vec2i(floor(uv * U.res));
  let d = (bayer[(pix.y & 3) * 4 + (pix.x & 3)] + 0.5) / 16.0 - 0.5;

  // One quantization step of jitter is exactly enough to break up a band.
  let jitter = d * p_dither() * p_ditherAmount() / steps;

  let c = floor((src.rgb + vec3f(jitter)) * steps + vec3f(0.5)) / steps;
  return vec4f(c, src.a);
}
`,
  }),

  top({
    id: 'threshold',
    label: 'Threshold',
    category: 'filter',
    runtime: 'shader',
    description:
      'Turns a chosen channel into a soft black-and-white mask above a threshold value.',
    td: 'Threshold TOP',
    keywords: ['binary', 'mask', 'cutoff', 'trace', 'two tone', 'monochrome'],
    inputs: ['Texture'],
    params: [
      F('threshold', 'Threshold', 0.5, 0, 1, { page: 'Threshold' }),
      F('softness', 'Softness', 0.02, 0, 0.5, { page: 'Threshold' }),
      BOOL('invert', 'Invert', false, { page: 'Threshold' }),
      MENU('channel', 'Source', 0, ['Luminance', 'Red', 'Green', 'Blue', 'Alpha'], {
        page: 'Threshold',
      }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);

  var v = luma(src.rgb);
  switch p_channelI() {
    case 1: { v = src.r; }
    case 2: { v = src.g; }
    case 3: { v = src.b; }
    case 4: { v = src.a; }
    default: {}
  }

  var m = softStep(p_threshold(), p_softness(), v);
  m = mix(m, 1.0 - m, p_invert());
  return vec4f(vec3f(m), src.a);
}
`,
  }),

  top({
    id: 'chroma-key',
    label: 'Chroma Key',
    category: 'filter',
    runtime: 'shader',
    description:
      'Removes a background colour by matching hue, saturation and value in HSV, with softness and green/blue spill suppression.',
    td: 'Chroma Key TOP',
    keywords: ['green screen', 'blue screen', 'key', 'matte', 'despill', 'alpha'],
    inputs: ['Texture'],
    params: [
      COLOR('keyColour', 'Key Colour', [0, 1, 0, 1], { page: 'Key' }),
      F('hueTol', 'Hue Tolerance', 0.08, 0, 0.5, { page: 'Key' }),
      F('satTol', 'Saturation Tolerance', 0.5, 0, 1, { page: 'Key' }),
      F('valTol', 'Value Tolerance', 0.6, 0, 1, { page: 'Key' }),
      F('softness', 'Softness', 0.05, 0, 0.5, { page: 'Key' }),
      F('spill', 'Spill Suppression', 0.5, 0, 1, { page: 'Despill' }),
      MENU('outputMode', 'Output', 0, ['Keyed', 'Matte', 'Inverted Matte'], { page: 'Output' }),
    ],
    shader: /* wgsl */ `
/** Falls from 1 inside tol to 0 at tol + soft. */
fn chromakey_gate(d: f32, tol: f32, soft: f32) -> f32 {
  return 1.0 - smoothstep(tol, tol + max(soft, 1.0e-4), d);
}

fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  let key = p_keyColour();

  // rgb2hsv is only defined for non-negative input; clamp rather than let
  // HDR/negative values produce a garbage hue.
  let hs = rgb2hsv(max(src.rgb, vec3f(0.0)));
  let hk = rgb2hsv(max(key.rgb, vec3f(0.0)));

  // Hue is circular, so the distance wraps at 1.0.
  var dh = abs(hs.x - hk.x);
  dh = min(dh, 1.0 - dh);
  let ds = abs(hs.y - hk.y);
  let dv = abs(hs.z - hk.z);

  let soft = p_softness();
  // Product of gates: any one axis being out of tolerance rejects the pixel,
  // which is what keeps a saturated green key from eating skin tones.
  let inKey = chromakey_gate(dh, p_hueTol(), soft)
            * chromakey_gate(ds, p_satTol(), soft)
            * chromakey_gate(dv, p_valTol(), soft);
  let matte = 1.0 - inKey;

  // Despill: pixels whose hue still leans toward the key (a green rim on hair)
  // are pulled toward neutral. The falloff is wider than the key tolerance so
  // it reaches the fringe the matte kept.
  let spill = p_spill() * (1.0 - smoothstep(0.0, p_hueTol() * 2.0 + 0.05, dh));
  let despilled = mix(src.rgb, vec3f(luma(src.rgb)), spill);

  var rgb = despilled;
  var a = src.a * matte;
  switch p_outputModeI() {
    case 1: { rgb = vec3f(matte); a = 1.0; }
    case 2: { rgb = vec3f(1.0 - matte); a = 1.0; }
    default: {}
  }
  return vec4f(rgb, a);
}
`,
  }),

  top({
    id: 'luma-key',
    label: 'Luma Key',
    category: 'filter',
    runtime: 'shader',
    description: 'Keys transparency from luminance, keeping pixels between a low and high level.',
    td: 'Luma Level TOP',
    keywords: ['key', 'matte', 'brightness key', 'alpha', 'cutout'],
    inputs: ['Texture'],
    params: [
      F('low', 'Low', 0, 0, 1, { page: 'Key' }),
      F('lowSoft', 'Low Softness', 0.05, 0, 0.5, { page: 'Key' }),
      F('high', 'High', 1, 0, 1, { page: 'Key' }),
      F('highSoft', 'High Softness', 0, 0, 0.5, { page: 'Key' }),
      MENU('outputMode', 'Output', 0, ['Keyed', 'Matte'], { page: 'Output' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  let l = luma(src.rgb);

  // The epsilons nudge each gate just outside the slider range so the default
  // low=0 / high=1 is a true pass-through: without them a pure black or pure
  // white pixel would land exactly on a smoothstep midpoint and get 0.5 alpha.
  let lowGate = softStep(p_low() - 1.0e-3, p_lowSoft(), l);
  let highGate = 1.0 - softStep(p_high() + 1.0e-3, p_highSoft(), l);
  let matte = lowGate * highGate;

  var rgb = src.rgb;
  var a = src.a * matte;
  if p_outputModeI() == 1 {
    rgb = vec3f(matte);
    a = 1.0;
  }
  return vec4f(rgb, a);
}
`,
  }),

  top({
    id: 'rgb-shift',
    label: 'RGB Shift',
    category: 'filter',
    runtime: 'shader',
    description:
      'Chromatic aberration that separates the red and blue channels linearly, radially, or as a per-channel barrel zoom.',
    td: 'Displace TOP',
    keywords: ['chromatic aberration', 'fringe', 'lens', 'dispersion', 'prism', 'colour split'],
    inputs: ['Texture'],
    params: [
      F('amount', 'Amount', 4, 0, 64, { page: 'Shift', unit: 'px' }),
      F('angle', 'Angle', 0, 0, 1, { page: 'Shift', unit: 'turns' }),
      MENU('mode', 'Mode', 0, ['Linear', 'Radial', 'Barrel'], { page: 'Shift' }),
      F('centreX', 'Centre X', 0.5, -1, 2, { page: 'Centre' }),
      F('centreY', 'Centre Y', 0.5, -1, 2, { page: 'Centre' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let ctr = vec2f(p_centreX(), p_centreY());
  let rel = uv - ctr;
  let amount = p_amount();
  let off = texel() * amount;
  let ang = p_angle() * TAU;
  let dir = vec2f(cos(ang), sin(ang));

  // Uniform-magnitude translation.
  let linR = uv + dir * off;
  let linB = uv - dir * off;

  // Radial: displacement grows with distance from centre, like a real lens
  // where aberration is zero on axis. length(rel)*2 makes the frame edge
  // roughly match the linear mode's magnitude.
  let rdir = rel / max(length(rel), 1.0e-4);
  let rmag = rdir * off * length(rel) * 2.0;
  let radR = uv + rmag;
  let radB = uv - rmag;

  // Barrel: a per-channel scale rather than a translation, so the fringe
  // follows the frame outward in every direction at once.
  let k = amount * 0.004;
  let barR = ctr + rel * (1.0 + k);
  let barB = ctr + rel * (1.0 - k);

  var uvR = linR;
  var uvB = linB;
  switch p_modeI() {
    case 1: { uvR = radR; uvB = radB; }
    case 2: { uvR = barR; uvB = barB; }
    default: {}
  }

  let cr = t0(uvR);
  let cg = t0(uv);
  let cb = t0(uvB);
  // Averaging alpha spreads the matte across the fringe instead of clipping
  // the shifted channels against the original edge.
  return vec4f(cr.r, cg.g, cb.b, (cr.a + cg.a + cb.a) / 3.0);
}
`,
  }),

  top({
    id: 'glitch',
    label: 'Glitch',
    category: 'filter',
    runtime: 'shader',
    description:
      'Analog VHS breakup combining tape tearing, block displacement, chroma bleed, scanlines, a rolling sync bar, static, desaturation and vignetting.',
    td: 'Displace TOP',
    keywords: ['vhs', 'analog', 'tape', 'datamosh', 'scanlines', 'static', 'broken', 'crt', 'retro'],
    inputs: ['Texture'],
    params: [
      F('amount', 'Amount', 1, 0, 1, { page: 'Glitch' }),
      F('speed', 'Speed', 1, 0, 4, { page: 'Glitch' }),
      F('tapeWarp', 'Tape Warp', 0.6, 0, 1, { page: 'Displace' }),
      F('blockGlitch', 'Block Glitch', 0.4, 0, 1, { page: 'Displace' }),
      F('roll', 'Roll Speed', 0.5, 0, 2, { page: 'Displace' }),
      F('chromaBleed', 'Chroma Bleed', 0.5, 0, 1, { page: 'Colour' }),
      F('desaturate', 'Desaturate', 0.2, 0, 1, { page: 'Colour' }),
      F('scanlines', 'Scanlines', 0.4, 0, 1, { page: 'Screen' }),
      INT('scanlineCount', 'Scanline Count', 240, 20, 1000, { page: 'Screen' }),
      F('noise', 'Static', 0.2, 0, 1, { page: 'Screen' }),
      F('vignette', 'Vignette', 0.3, 0, 1, { page: 'Screen' }),
    ],
    shader: /* wgsl */ `
/**
 * Tape only wraps horizontally: the head keeps scanning across the width, but
 * a vertical shift would reveal frame edges that never existed.
 */
fn glitch_wrap(p: vec2f) -> vec2f {
  return vec2f(fract(p.x), clamp(p.y, 0.0, 1.0));
}

/**
 * Signed displacement for one band scale. The sharpness exponent raises a uniform random
 * to a power, which skews the distribution hard toward zero so only a few
 * bands tear at any instant — real tape damage is sparse, not uniform.
 */
fn glitch_band(y: f32, freq: f32, tq: f32, salt: f32, sharpness: f32) -> f32 {
  let band = floor(y * freq + salt);
  let tear = pow(hash21(vec2f(band, tq + salt)), sharpness);
  let dir = hash21(vec2f(band, tq * 1.31 + salt + 5.0)) * 2.0 - 1.0;
  return tear * dir;
}

fn shade(uv: vec2f) -> vec4f {
  let amt = p_amount();
  let spd = max(p_speed(), 0.0);

  // Quantised clock: the random state only advances 12x per second at speed 1.
  // Sampling noise on a continuous clock reads as smooth drift; stepping it
  // reads as a tape transport stuttering, which is the whole look.
  let tq = floor(U.time * spd * 12.0);
  let tc = U.time * spd;

  // ------------------------------------------------- rolling sync bar ------
  let rollSpeed = p_roll();
  let rollPos = fract(tc * rollSpeed * 0.3);
  // Wrapped distance to the bar so it survives crossing the frame edge.
  let dRoll = abs(fract(uv.y - rollPos + 0.5) - 0.5);
  // Gate on speed as well as position: at speed 0 a frozen bar would just look
  // like a static stripe, so it fades out instead.
  let bar = (1.0 - smoothstep(0.0, 0.045, dRoll)) * clamp(rollSpeed * 4.0, 0.0, 1.0);

  // -------------------------------------------------- tape displacement ----
  let warp = p_tapeWarp();
  var shiftX = 0.0;
  shiftX = shiftX + glitch_band(uv.y, 14.0, tq,  0.0,  5.0) * 0.10 * warp;
  shiftX = shiftX + glitch_band(uv.y, 90.0, tq, 17.0, 14.0) * 0.03 * warp;
  // Slow continuous weave from tape tension, under the stepped tearing.
  shiftX = shiftX + (vnoise(vec2f(uv.y * 4.0, tc * 0.7)) - 0.5) * 0.012 * warp;
  // The sync bar drags the picture sideways as it sweeps past.
  shiftX = shiftX + bar * 0.04;

  // --------------------------------------------------- block / datamosh ----
  let bg = p_blockGlitch();
  // Offsetting the block grid by a hash of the clock stops the blocks from
  // always landing in the same places.
  let blockId = floor(vec2f(uv.x * 10.0, uv.y * 26.0) + vec2f(hash11(tq) * 3.0, 0.0));
  let blockOn = step(1.0 - 0.35 * bg, hash21(blockId + vec2f(tq * 2.7, tq * 1.9)));
  let blockOff = (hash22(blockId + vec2f(tq * 5.0, 3.0)) * 2.0 - vec2f(1.0))
               * vec2f(0.09, 0.012) * blockOn;

  let sp = glitch_wrap(uv + (vec2f(shiftX, 0.0) + blockOff) * amt);

  // --------------------------------------------------------- chroma bleed --
  // Horizontal-only separation, because NTSC loses chroma bandwidth along the
  // scan direction. Damaged regions bleed more.
  let bleed = (p_chromaBleed() * 0.010 + bar * 0.008 + blockOn * bg * 0.006) * amt;
  let cr = t0(glitch_wrap(sp + vec2f(bleed, 0.0)));
  let cc = t0(sp);
  let cb = t0(glitch_wrap(sp - vec2f(bleed * 0.6, 0.0)));
  var col = vec3f(cr.r, cc.g, cb.b);
  let alpha = cc.a;

  // ------------------------------------------------------------ scanlines --
  let slCount = f32(max(p_scanlineCountI(), 1));
  // Fade the pattern out as it approaches Nyquist for the current render
  // height; past that point it is pure moire rather than scanlines.
  let slFade = clamp((U.res.y * 0.5) / slCount, 0.0, 1.0);
  let lines = 0.5 + 0.5 * cos(uv.y * slCount * TAU + tc * 6.0);
  col = col * mix(1.0, 0.35 + 0.65 * lines, p_scanlines() * amt * slFade);

  // --------------------------------------------------------------- static --
  // Half-resolution cells: tape grain is chunkier than one pixel, and per-pixel
  // noise would just look like dither.
  let n = hash21(floor(uv * U.res * 0.5) + vec2f(tq * 13.0, tq * 7.0));
  col = col + vec3f((n - 0.5) * p_noise() * amt * (0.5 + bar));

  // Brief white dropout dashes where the head loses contact.
  let dropRow = floor(uv.y * 220.0);
  let dropOn = step(0.985, hash21(vec2f(dropRow, tq * 3.7)))
             * (1.0 - step(0.06, fract(uv.x - hash21(vec2f(dropRow + 31.0, tq * 1.1)))));
  col = col + vec3f(dropOn * warp * amt * 0.6);

  // The bar overloads the head amplifier: lifted blacks and extra gain.
  col = mix(col, col * 1.3 + vec3f(0.05), bar * amt);

  col = mix(col, vec3f(luma(col)), p_desaturate() * amt);

  let vp = (uv - vec2f(0.5)) * vec2f(U.aspect, 1.0) * 2.0;
  col = col * mix(1.0, 1.0 - smoothstep(0.75, 1.7, length(vp)), p_vignette() * amt);

  return vec4f(col, alpha);
}
`,
  }),

  top({
    id: 'film-grain',
    label: 'Film Grain',
    category: 'filter',
    runtime: 'shader',
    description:
      'Adds animated photographic grain with controllable size, colour, and a response curve that concentrates grain in the shadows.',
    td: 'Noise TOP',
    keywords: ['grain', 'noise', 'film', '16mm', 'texture', 'analog'],
    inputs: ['Texture'],
    params: [
      F('amount', 'Amount', 0.15, 0, 1, { page: 'Grain' }),
      F('size', 'Size', 1, 0.25, 8, { page: 'Grain', unit: 'px' }),
      BOOL('colourGrain', 'Colour Grain', false, { page: 'Grain' }),
      F('response', 'Shadow Weighting', 0.5, 0, 1, {
        page: 'Grain',
        help: '0 is uniform grain, 1 puts all grain in the shadows.',
      }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);

  // Grain cells are sized in pixels so the look is resolution independent.
  let cell = max(p_size(), 0.25);
  let gp = floor(uv * U.res / cell);
  // Resample at 24 fps rather than per frame: grain that changes every display
  // frame at 60+ Hz averages out to a flat haze on the eye.
  let tSeed = floor(U.time * 24.0);

  let nr = hash31(vec3f(gp, tSeed)) - 0.5;
  let ng = hash31(vec3f(gp + vec2f(37.0, 11.0), tSeed)) - 0.5;
  let nb = hash31(vec3f(gp + vec2f(91.0, 57.0), tSeed)) - 0.5;
  let n = mix(vec3f(nr), vec3f(nr, ng, nb), p_colourGrain());

  // Real emulsion grain is most visible in the mid-shadows and washes out in
  // highlights, so the response control biases it toward dark areas.
  let l = clamp(luma(src.rgb), 0.0, 1.0);
  let weight = mix(1.0, 1.0 - smoothstep(0.0, 1.0, l), p_response());

  return vec4f(src.rgb + n * p_amount() * weight * 2.0, src.a);
}
`,
  }),

  top({
    id: 'halftone',
    label: 'Halftone',
    category: 'filter',
    runtime: 'shader',
    description:
      'Reproduces the image as a print-style dot screen, either as a single monochrome screen or four rotated CMYK screens.',
    td: 'Halftone TOP',
    keywords: ['dots', 'print', 'newsprint', 'screen', 'cmyk', 'comic', 'ben day'],
    inputs: ['Texture'],
    params: [
      F('scale', 'Dot Size', 6, 2, 64, { page: 'Screen', unit: 'px' }),
      F('angle', 'Angle', 0, 0, 1, { page: 'Screen', unit: 'turns' }),
      MENU('mode', 'Mode', 0, ['Monochrome', 'CMYK'], { page: 'Screen' }),
      F('sharpness', 'Sharpness', 0.7, 0, 1, { page: 'Screen' }),
    ],
    shader: /* wgsl */ `
/**
 * Screen space: uv recentred and aspect-corrected so cells stay square and
 * rotation happens about the middle of the frame.
 */
fn halftone_toScreen(uv: vec2f, ang: f32) -> vec2f {
  return rot2(ang) * ((uv - vec2f(0.5)) * vec2f(U.aspect, 1.0));
}

/** Source colour at the centre of the cell this pixel belongs to. */
fn halftone_cellColour(uv: vec2f, cell: f32, ang: f32) -> vec4f {
  let q = halftone_toScreen(uv, ang);
  let centre = (floor(q / cell) + vec2f(0.5)) * cell;
  let back = rot2(-ang) * centre;
  let cuv = back / vec2f(U.aspect, 1.0) + vec2f(0.5);
  return t0(clamp(cuv, vec2f(0.0), vec2f(1.0)));
}

/** Ink coverage 0..1 for a cell with the given tonal value. */
fn halftone_cover(uv: vec2f, cell: f32, ang: f32, value: f32, sharp: f32) -> f32 {
  let local = fract(halftone_toScreen(uv, ang) / cell) - vec2f(0.5);
  let d = length(local) * 2.0;
  // sqrt() because ink coverage is proportional to dot *area*; 1.45 lets a
  // full-value cell overlap its neighbours and reach solid ink.
  let r = sqrt(clamp(value, 0.0, 1.0)) * 1.45;
  let e = mix(0.35, 0.01, clamp(sharp, 0.0, 1.0));
  return 1.0 - smoothstep(r - e, r + e, d);
}

/** RGB -> CMYK with full black generation. */
fn halftone_cmyk(c: vec3f) -> vec4f {
  let k = 1.0 - max(max(c.r, c.g), c.b);
  let d = max(1.0 - k, 1.0e-4);
  return vec4f((1.0 - c.r - k) / d, (1.0 - c.g - k) / d, (1.0 - c.b - k) / d, k);
}

fn shade(uv: vec2f) -> vec4f {
  // Cell size in screen space, where 1.0 spans U.res.y pixels vertically.
  let cell = max(p_scale(), 1.0) / max(U.res.y, 1.0);
  let ang = p_angle() * TAU;
  let sharp = p_sharpness();

  var rgb = vec3f(1.0);
  var a = 1.0;

  // Uniform menu test, so texture sampling inside either branch is legal.
  if p_modeI() == 1 {
    // Traditional screen angles: 15/75/0/45 degrees. Offsetting the screens
    // like this is what stops the four plates forming a visible moire rosette.
    let aC = ang + radians(15.0);
    let aM = ang + radians(75.0);
    let aY = ang;
    let aK = ang + radians(45.0);

    let sC = halftone_cmyk(clamp(halftone_cellColour(uv, cell, aC).rgb, vec3f(0.0), vec3f(1.0)));
    let sM = halftone_cmyk(clamp(halftone_cellColour(uv, cell, aM).rgb, vec3f(0.0), vec3f(1.0)));
    let sY = halftone_cmyk(clamp(halftone_cellColour(uv, cell, aY).rgb, vec3f(0.0), vec3f(1.0)));
    let sK4 = halftone_cellColour(uv, cell, aK);
    let sK = halftone_cmyk(clamp(sK4.rgb, vec3f(0.0), vec3f(1.0)));

    let inkC = halftone_cover(uv, cell, aC, sC.x, sharp);
    let inkM = halftone_cover(uv, cell, aM, sM.y, sharp);
    let inkY = halftone_cover(uv, cell, aY, sY.z, sharp);
    let inkK = halftone_cover(uv, cell, aK, sK.w, sharp);

    // Subtractive: each ink multiplies out the light it absorbs.
    rgb = vec3f(1.0);
    rgb = rgb * mix(vec3f(1.0), vec3f(0.0, 1.0, 1.0), inkC);
    rgb = rgb * mix(vec3f(1.0), vec3f(1.0, 0.0, 1.0), inkM);
    rgb = rgb * mix(vec3f(1.0), vec3f(1.0, 1.0, 0.0), inkY);
    rgb = rgb * mix(vec3f(1.0), vec3f(0.0), inkK);
    a = sK4.a;
  } else {
    let src = halftone_cellColour(uv, cell, ang);
    // Dot size tracks darkness, matching black ink on white paper.
    let ink = halftone_cover(uv, cell, ang, 1.0 - clamp(luma(src.rgb), 0.0, 1.0), sharp);
    rgb = vec3f(1.0 - ink);
    a = src.a;
  }

  return vec4f(rgb, a);
}
`,
  }),

  top({
    id: 'vignette',
    label: 'Vignette',
    category: 'filter',
    runtime: 'shader',
    description:
      'Darkens or tints the edges of the frame with adjustable radius, softness and roundness.',
    td: 'Vignette TOP',
    keywords: ['edge darken', 'lens', 'falloff', 'border', 'frame', 'corner'],
    inputs: ['Texture'],
    params: [
      F('amount', 'Amount', 1, 0, 1, { page: 'Vignette' }),
      F('radius', 'Radius', 0.7, 0, 2, { page: 'Vignette' }),
      F('softness', 'Softness', 0.5, 0, 2, { page: 'Vignette' }),
      F('roundness', 'Roundness', 1, 0, 1, {
        page: 'Vignette',
        help: '0 follows the frame aspect, 1 is a true circle.',
      }),
      COLOR('tint', 'Tint', [0, 0, 0, 1], {
        page: 'Vignette',
        help: 'Colour the edges fade to; alpha 0 fades to transparent instead.',
      }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  let tint = p_tint();

  var p = (uv - vec2f(0.5)) * 2.0;
  // Roundness interpolates between an ellipse stretched to the frame (0) and a
  // circle in aspect-corrected space (1).
  p.x = p.x * mix(1.0, U.aspect, clamp(p_roundness(), 0.0, 1.0));

  let r = p_radius();
  let inner = 1.0 - smoothstep(r, r + max(p_softness(), 1.0e-4), length(p));
  // At amount 0 the mask is 1 everywhere, i.e. an exact pass-through.
  let mask = mix(1.0, inner, clamp(p_amount(), 0.0, 1.0));

  let rgb = mix(tint.rgb, src.rgb, mask);
  // Tint alpha decides whether the edge becomes a colour or becomes see-through.
  let a = src.a * mix(tint.a, 1.0, mask);
  return vec4f(rgb, a);
}
`,
  }),

  top({
    id: 'invert-channels',
    label: 'Invert Channels',
    category: 'filter',
    runtime: 'shader',
    description: 'Inverts individual RGBA channels and optionally reorders them with a swizzle.',
    td: 'Reorder TOP',
    keywords: ['invert', 'negative', 'swizzle', 'reorder', 'channels', 'rgba', 'utility'],
    inputs: ['Texture'],
    params: [
      MENU('swizzle', 'Swizzle', 0, ['RGBA', 'BGRA', 'GBRA', 'RRRA', 'GGGA', 'BBBA', 'AAAA'], {
        page: 'Channels',
      }),
      BOOL('invR', 'Invert Red', false, { page: 'Invert' }),
      BOOL('invG', 'Invert Green', false, { page: 'Invert' }),
      BOOL('invB', 'Invert Blue', false, { page: 'Invert' }),
      BOOL('invA', 'Invert Alpha', false, { page: 'Invert' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);

  // Swizzle first, so the invert toggles always refer to the output channels
  // the user is looking at rather than the source ordering.
  var c = src;
  switch p_swizzleI() {
    case 1: { c = vec4f(src.b, src.g, src.r, src.a); }
    case 2: { c = vec4f(src.g, src.b, src.r, src.a); }
    case 3: { c = vec4f(src.r, src.r, src.r, src.a); }
    case 4: { c = vec4f(src.g, src.g, src.g, src.a); }
    case 5: { c = vec4f(src.b, src.b, src.b, src.a); }
    case 6: { c = vec4f(src.a, src.a, src.a, src.a); }
    default: {}
  }

  let flags = vec4f(p_invR(), p_invG(), p_invB(), p_invA());
  return mix(c, vec4f(1.0) - c, flags);
}
`,
  }),

  top({
    id: 'bit-crush',
    label: 'Bit Crush',
    category: 'filter',
    runtime: 'shader',
    description:
      'Retro console look: reduces bit depth per channel, drops resolution, and can snap colours to a fixed hardware palette.',
    td: 'Level TOP',
    keywords: ['8 bit', 'retro', 'gameboy', 'cga', 'palette', 'lofi', 'quantize', 'downsample'],
    inputs: ['Texture'],
    params: [
      INT('bits', 'Bits per Channel', 3, 1, 8, { page: 'Crush' }),
      F('downsample', 'Downsample', 1, 1, 32, { page: 'Crush', unit: 'px' }),
      MENU('palette', 'Palette', 0, ['None', 'Gameboy', 'CGA', 'Amber'], { page: 'Crush' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  // Resolution reduction first: quantising colour before downsampling would
  // just get averaged back into intermediate values by the sampler.
  let down = max(p_downsample(), 1.0);
  let cellUv = (floor(uv * U.res / down) + vec2f(0.5)) * down / U.res;
  let src = t0(cellUv);

  let steps = pow(2.0, f32(clamp(p_bitsI(), 1, 8))) - 1.0;
  var c = floor(clamp(src.rgb, vec3f(0.0), vec3f(1.0)) * steps + vec3f(0.5)) / steps;

  // Palettes are authored in the same nominal 0..1 space as everything else in
  // the toolkit, so nearest-colour matching happens directly on those values.
  var pal = array<vec3f, 8>(
    vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0),
    vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0)
  );
  var count = 0;
  switch p_paletteI() {
    case 1: {
      // Original DMG Game Boy LCD greens.
      pal[0] = vec3f(0.059, 0.220, 0.059);
      pal[1] = vec3f(0.188, 0.384, 0.188);
      pal[2] = vec3f(0.545, 0.675, 0.059);
      pal[3] = vec3f(0.608, 0.737, 0.059);
      count = 4;
    }
    case 2: {
      // CGA mode 4 palette 1: black / cyan / magenta / white.
      pal[0] = vec3f(0.0);
      pal[1] = vec3f(0.0, 0.667, 0.667);
      pal[2] = vec3f(0.667, 0.0, 0.667);
      pal[3] = vec3f(1.0);
      count = 4;
    }
    case 3: {
      // Amber monochrome terminal ramp (#ffb000 phosphor).
      pal[0] = vec3f(0.031, 0.016, 0.0);
      pal[1] = vec3f(0.400, 0.180, 0.0);
      pal[2] = vec3f(0.800, 0.450, 0.0);
      pal[3] = vec3f(1.000, 0.760, 0.35);
      count = 4;
    }
    default: {}
  }

  if count > 0 {
    var best = 0;
    var bestD = 1.0e9;
    for (var i = 0; i < 8; i = i + 1) {
      if i >= count { break; }
      let d = c - pal[i];
      let dist = dot(d, d);
      // Squared distance is enough; sqrt would not change the ordering.
      if dist < bestD {
        bestD = dist;
        best = i;
      }
    }
    c = pal[best];
  }

  return vec4f(c, src.a);
}
`,
  }),
]
