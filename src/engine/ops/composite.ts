/**
 * Compositing operators.
 *
 * Everything in this file obeys one rule: the pipeline stores NON-premultiplied
 * (straight) RGBA, but compositing is only correct in premultiplied space. So
 * every operator premultiplies, does its maths, combines coverage as
 * `a = as + ad*(1-as)`, and un-premultiplies on the way out (guarding the
 * divide). That keeps results identical whether an operator is used alone or
 * chained into another compositor.
 */

import { BOOL, COLOR, F, INT, MENU, top, type OperatorSpec } from './kit'

/**
 * Blend mode labels. The index of each entry IS the numeric mode consumed by
 * `blendRgb()` in the WGSL prelude, so this order must not be reshuffled.
 */
export const BLEND_MODES: string[] = [
  'Over',
  'Add',
  'Subtract',
  'Multiply',
  'Screen',
  'Overlay',
  'Difference',
  'Darken',
  'Lighten',
  'Dodge',
  'Burn',
  'Hard Light',
  'Soft Light',
  'Exclusion',
  'Divide',
  'Average',
]

/** Mask/matte channel choices, shared by `mask`, `matte` and friends. */
const CHANNEL_MODES = ['Luminance', 'Red', 'Green', 'Blue', 'Alpha']

/**
 * Channel routing sources for `channel-mix`. The index is used directly as the
 * lookup index into the twelve-entry array built in that operator's shader.
 */
const CHANNEL_SOURCES = [
  '1:R',
  '1:G',
  '1:B',
  '1:A',
  '1:Lum',
  '2:R',
  '2:G',
  '2:B',
  '2:A',
  '2:Lum',
  'Zero',
  'One',
]

/**
 * Helpers shared by the operators below. Each operator is compiled as its own
 * shader module, so the one `cx_` prefix can be reused in all of them without
 * any chance of a name collision.
 */
const CX_LIB = /* wgsl */ `
/** Straight -> premultiplied. */
fn cx_premul(c: vec4f) -> vec4f {
  let a = clamp(c.a, 0.0, 1.0);
  return vec4f(c.rgb * a, a);
}

/**
 * Premultiplied -> straight. A zero-coverage premultiplied colour carries no
 * information at all, so it resolves to transparent black rather than dividing.
 */
fn cx_unpremul(c: vec4f) -> vec4f {
  if c.a <= 1.0e-6 { return vec4f(0.0); }
  return vec4f(c.rgb / c.a, c.a);
}

/**
 * Generalised source-over with a separable blend function - the same formula
 * the PDF / CSS compositing specs use:
 *
 *   Co = as*(1-ad)*Cs  +  as*ad*B(Cd,Cs)  +  (1-as)*ad*Cd
 *   ao = as + ad*(1-as)
 *
 * The three terms are the source-only, overlap and destination-only regions of
 * the pixel, which is why the blend function only ever sees the overlap: a
 * "multiply" against transparent background must not turn the foreground
 * black. With mode 0 the blend function returns Cs and the whole thing
 * collapses to the prelude's overBlend(). Result is un-premultiplied again so
 * it re-enters the pipeline in straight-alpha form.
 */
fn cx_blend(dst: vec4f, src: vec4f, mode: i32) -> vec4f {
  let ad = clamp(dst.a, 0.0, 1.0);
  let sa = clamp(src.a, 0.0, 1.0);
  let ao = sa + ad * (1.0 - sa);
  if ao <= 1.0e-6 { return vec4f(0.0); }
  let b = blendRgb(dst.rgb, src.rgb, mode);
  let co = sa * (1.0 - ad) * src.rgb + sa * ad * b + (1.0 - sa) * ad * dst.rgb;
  return vec4f(co / ao, ao);
}

/**
 * Scales coverage only. In premultiplied terms this multiplies both colour and
 * alpha by k, which is why the straight RGB is left untouched.
 */
fn cx_opacity(c: vec4f, k: f32) -> vec4f {
  return vec4f(c.rgb, clamp(c.a, 0.0, 1.0) * clamp(k, 0.0, 1.0));
}

/** 0 luminance, 1 R, 2 G, 3 B, 4 A. */
fn cx_channel(c: vec4f, mode: i32) -> f32 {
  switch mode {
    case 1: { return c.r; }
    case 2: { return c.g; }
    case 3: { return c.b; }
    case 4: { return c.a; }
    default: { return luma(c.rgb); }
  }
}

/**
 * Interpolates two straight-alpha images. Done premultiplied, otherwise the
 * colour stored under a transparent pixel (usually black) bleeds into the
 * result and every dissolve gets a dark fringe.
 */
fn cx_mixStraight(a: vec4f, b: vec4f, x: f32) -> vec4f {
  return cx_unpremul(mix(cx_premul(a), cx_premul(b), clamp(x, 0.0, 1.0)));
}

/**
 * Hue-preserving ceiling. Per-channel clamping shifts hue (a 1.4/0.2/0.2 red
 * clips to yellow-free but desaturated); scaling the whole triple by the max
 * channel keeps the colour and only loses brightness.
 */
fn cx_normalize(c: vec3f) -> vec3f {
  let m = max(max(c.r, c.g), c.b);
  return c / max(m, 1.0);
}
`

export const compositeOperators: OperatorSpec[] = [
  // ------------------------------------------------------------- composite ----
  top({
    id: 'composite',
    label: 'Composite',
    category: 'composite',
    runtime: 'shader',
    description:
      'Composites the foreground over the background with a blend mode, opacity and alpha-correct coverage maths.',
    td: 'Composite TOP',
    keywords: ['composite', 'over', 'blend', 'merge', 'layer', 'alpha'],
    inputs: ['Background', 'Foreground'],
    params: [
      MENU('blend', 'Blend Mode', 0, BLEND_MODES, { page: 'Composite' }),
      F('opacity', 'Opacity', 1, 0, 1, { page: 'Composite' }),
      BOOL('premult', 'Pre-Multiply Inputs', false, {
        page: 'Composite',
        help: 'Multiplies each input RGB by its own alpha before blending. Use when a source was authored premultiplied.',
      }),
      BOOL('swap', 'Swap Inputs', false, { page: 'Composite' }),
      MENU('limit', 'Output Alpha', 0, ['Union', 'Background', 'Foreground'], {
        page: 'Composite',
        help: 'Limits the resulting coverage. Affects alpha only; RGB is unchanged.',
      }),
    ],
    shader: /* wgsl */ `${CX_LIB}
fn shade(uv: vec2f) -> vec4f {
  let in0 = t0(uv);
  let in1 = t1(uv);
  let swap = p_swapB();
  var bg = select(in0, in1, swap);
  var fg = select(in1, in0, swap);

  // Optional "these inputs were authored premultiplied" fixup. Done before any
  // coverage maths so the rest of the operator can assume straight alpha.
  if p_premultB() {
    bg = vec4f(bg.rgb * clamp(bg.a, 0.0, 1.0), bg.a);
    fg = vec4f(fg.rgb * clamp(fg.a, 0.0, 1.0), fg.a);
  }

  // Opacity is coverage, not brightness: it scales the foreground's alpha, and
  // the premultiplied blend below turns that into the expected fade.
  fg = cx_opacity(fg, p_opacity());

  let mixed = cx_blend(bg, fg, p_blendI());

  // Alpha limiting. RGB stays as composited so switching this only changes what
  // downstream operators consider covered, never the visible colour.
  var a = mixed.a;
  switch p_limitI() {
    case 1: { a = clamp(bg.a, 0.0, 1.0); }
    case 2: { a = clamp(fg.a, 0.0, 1.0); }
    default: {}
  }
  return vec4f(mixed.rgb, a);
}
`,
  }),

  // ------------------------------------------------------------ composite4 ----
  top({
    id: 'composite4',
    label: 'Multi Composite',
    category: 'composite',
    runtime: 'shader',
    description:
      'Stacks up to four inputs bottom-to-top in one node with a shared blend mode and per-input opacity.',
    td: 'Multiply TOP / Composite TOP (multi-input)',
    keywords: ['composite', 'multi', 'stack', 'layers', 'merge', 'four'],
    inputs: ['Input 1', 'Input 2', 'Input 3', 'Input 4'],
    params: [
      MENU('blend', 'Blend Mode', 0, BLEND_MODES, { page: 'Composite' }),
      F('opacity1', 'Opacity 1', 1, 0, 1, { page: 'Opacity' }),
      F('opacity2', 'Opacity 2', 1, 0, 1, { page: 'Opacity' }),
      F('opacity3', 'Opacity 3', 1, 0, 1, { page: 'Opacity' }),
      F('opacity4', 'Opacity 4', 1, 0, 1, { page: 'Opacity' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
fn shade(uv: vec2f) -> vec4f {
  let mode = p_blendI();

  // Input 1 is the bottom layer. An unwired input is transparent black, and
  // cx_blend with as = 0 returns the destination untouched (and with ad = 0
  // returns the source untouched), so every missing layer is an exact no-op in
  // either position - no connection tests needed.
  var acc = cx_opacity(t0(uv), p_opacity1());
  acc = cx_blend(acc, cx_opacity(t1(uv), p_opacity2()), mode);
  acc = cx_blend(acc, cx_opacity(t2(uv), p_opacity3()), mode);
  acc = cx_blend(acc, cx_opacity(t3(uv), p_opacity4()), mode);
  return acc;
}
`,
  }),

  // ----------------------------------------------------------------- cross ----
  top({
    id: 'cross',
    label: 'Cross',
    category: 'composite',
    runtime: 'shader',
    description: 'Dissolves between two inputs with a shaped fade curve and optional linear-light mixing.',
    td: 'Cross TOP',
    keywords: ['cross', 'dissolve', 'fade', 'mix', 'transition', 'crossfade'],
    inputs: ['Input 1', 'Input 2'],
    params: [
      F('cross', 'Cross Fade', 0, 0, 1, {
        page: 'Cross',
        help: '0 is input 1, 1 is input 2.',
      }),
      MENU('interp', 'Interpolation', 0, ['Linear', 'Smooth', 'Ease In', 'Ease Out'], {
        page: 'Cross',
      }),
      BOOL('linearlight', 'Fade in Linear Light', false, {
        page: 'Cross',
        help: 'Mixes in linear light so the midpoint keeps its brightness instead of going muddy. Clamps to 0..1, so leave off for HDR values.',
      }),
    ],
    shader: /* wgsl */ `${CX_LIB}
fn cross_curve(x: f32, mode: i32) -> f32 {
  switch mode {
    case 1: { return x * x * (3.0 - 2.0 * x); }
    case 2: { return x * x; }
    case 3: { return 1.0 - (1.0 - x) * (1.0 - x); }
    default: { return x; }
  }
}

fn shade(uv: vec2f) -> vec4f {
  let a = t0(uv);
  let b = t1(uv);
  let x = cross_curve(clamp(p_cross(), 0.0, 1.0), p_interpI());
  let lin = p_linearlightB();

  // select() evaluates both arms, and srgb2lin uses pow(), which is undefined
  // for negative input - hence the unconditional clamp on the linear arm.
  let ca = select(a.rgb, srgb2lin(clamp(a.rgb, vec3f(0.0), vec3f(1.0))), lin);
  let cb = select(b.rgb, srgb2lin(clamp(b.rgb, vec3f(0.0), vec3f(1.0))), lin);

  // Premultiplied interpolation: coverage and colour fade together, so a
  // transparent side contributes nothing rather than pulling toward its
  // undefined RGB.
  let aa = clamp(a.a, 0.0, 1.0);
  let ab = clamp(b.a, 0.0, 1.0);
  let pm = mix(vec4f(ca * aa, aa), vec4f(cb * ab, ab), x);
  if pm.a <= 1.0e-6 { return vec4f(0.0); }

  var rgb = pm.rgb / pm.a;
  rgb = select(rgb, lin2srgb(max(rgb, vec3f(0.0))), lin);
  return vec4f(rgb, pm.a);
}
`,
  }),

  // ---------------------------------------------------------------- switch ----
  top({
    id: 'switch',
    label: 'Switch',
    category: 'composite',
    runtime: 'shader',
    description: 'Selects one of four inputs by index, optionally crossfading between neighbouring inputs.',
    td: 'Switch TOP',
    keywords: ['switch', 'select', 'index', 'router', 'choose'],
    inputs: ['Input 1', 'Input 2', 'Input 3', 'Input 4'],
    params: [
      F('index', 'Index', 0, 0, 3, { page: 'Switch', step: 0.001 }),
      BOOL('blend', 'Blend', false, {
        page: 'Switch',
        help: 'Crossfades between the two inputs the index sits between instead of hard switching.',
      }),
    ],
    shader: /* wgsl */ `${CX_LIB}
fn shade(uv: vec2f) -> vec4f {
  let idx = clamp(p_index(), 0.0, 3.0);
  let lo = i32(floor(idx));
  let hi = min(lo + 1, 3);
  let f = idx - floor(idx);

  // Every sample happens at the top level of the function. The indices come
  // from the uniform buffer, so tin()'s internal switch is uniform control
  // flow and the implicit derivatives stay well defined.
  let hard = tin(i32(round(idx)), uv);
  let a = tin(lo, uv);
  let b = tin(hi, uv);

  let soft = cx_mixStraight(a, b, f);
  return select(hard, soft, p_blendB());
}
`,
  }),

  // ------------------------------------------------------------------ mask ----
  top({
    id: 'mask',
    label: 'Mask',
    category: 'composite',
    runtime: 'shader',
    description: "Modulates the first input's alpha (or all channels) with a channel of the second input.",
    td: 'Multiply TOP / Matte TOP',
    keywords: ['mask', 'matte', 'stencil', 'multiply', 'alpha', 'cutout'],
    inputs: ['Texture', 'Mask'],
    params: [
      MENU('channel', 'Mask Channel', 0, CHANNEL_MODES, { page: 'Mask' }),
      BOOL('invert', 'Invert Mask', false, { page: 'Mask' }),
      MENU('mode', 'Apply', 0, ['Multiply Alpha', 'Multiply RGBA', 'Replace Alpha'], {
        page: 'Mask',
      }),
      F('gain', 'Mask Gain', 1, 0, 4, { page: 'Mask' }),
      F('bias', 'Mask Bias', 0, -1, 1, { page: 'Mask' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
/**
 * An unwired input is a 1x1 transparent-black placeholder, which as a mask
 * would blank the frame. Treating that as "no mask" makes the operator a
 * pass-through until a mask is actually connected. The dimensions come from the
 * bind group, so this is a uniform value and safe to branch on.
 */
fn mask_connected() -> bool {
  let d = textureDimensions(T1, 0);
  return d.x > 1u || d.y > 1u;
}

fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  var m = cx_channel(t1(uv), p_channelI()) * max(p_gain(), 0.0) + p_bias();
  m = clamp(m, 0.0, 1.0);
  if p_invertB() { m = 1.0 - m; }
  if !mask_connected() { m = 1.0; }

  switch p_modeI() {
    // Straight RGB scaled as well as alpha: darkens toward black instead of
    // only fading out. Equivalent to a multiply against a black plate.
    case 1: { return vec4f(src.rgb * m, clamp(src.a, 0.0, 1.0) * m); }
    // Discards existing coverage entirely.
    case 2: { return vec4f(src.rgb, m); }
    // Scaling alpha alone scales the premultiplied colour by exactly the same
    // factor, which is what makes this the alpha-correct default.
    default: { return vec4f(src.rgb, clamp(src.a, 0.0, 1.0) * m); }
  }
}
`,
  }),

  // ----------------------------------------------------------------- matte ----
  top({
    id: 'matte',
    label: 'Matte',
    category: 'composite',
    runtime: 'shader',
    description: "Takes RGB from the first input and builds its alpha from a channel of the second input.",
    td: 'Matte TOP',
    keywords: ['matte', 'alpha', 'combine', 'key', 'luminance', 'holdout'],
    inputs: ['RGB', 'Alpha'],
    params: [
      MENU('channel', 'Alpha From', 0, CHANNEL_MODES, { page: 'Matte' }),
      BOOL('invert', 'Invert', false, { page: 'Matte' }),
      F('gain', 'Gain', 1, 0, 4, { page: 'Matte' }),
      F('bias', 'Bias', 0, -1, 1, { page: 'Matte' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
/** See mask: a 1x1 placeholder means nothing is wired to the alpha input. */
fn matte_connected() -> bool {
  let d = textureDimensions(T1, 0);
  return d.x > 1u || d.y > 1u;
}

fn shade(uv: vec2f) -> vec4f {
  let col = t0(uv);
  var a = cx_channel(t1(uv), p_channelI()) * max(p_gain(), 0.0) + p_bias();
  a = clamp(a, 0.0, 1.0);
  if p_invertB() { a = 1.0 - a; }

  // Because the pipeline is straight-alpha, replacing coverage is a plain
  // channel write - no un-premultiply of the incoming colour is needed. The
  // colour under the transparent parts is preserved, so a later Composite can
  // still grow the matte without revealing black.
  return vec4f(col.rgb, select(clamp(col.a, 0.0, 1.0), a, matte_connected()));
}
`,
  }),

  // ------------------------------------------------------- keyed-composite ----
  top({
    id: 'keyed-composite',
    label: 'Keyed Composite',
    category: 'composite',
    runtime: 'shader',
    description:
      'Chroma-keys the foreground in HSV, suppresses spill, shrinks or grows the matte, and composites it over the background in one node.',
    td: 'Chroma Key TOP + Composite TOP',
    keywords: ['chroma', 'key', 'green screen', 'bluescreen', 'despill', 'composite'],
    inputs: ['Background', 'Foreground'],
    params: [
      COLOR('keycolor', 'Key Colour', [0, 1, 0, 1], { page: 'Key' }),
      F('huetol', 'Hue Tolerance', 0.08, 0, 0.5, {
        page: 'Key',
        help: 'In turns: 0.08 is roughly 29 degrees of hue either side.',
      }),
      F('sattol', 'Saturation Tolerance', 0.5, 0.001, 1, { page: 'Key' }),
      F('valtol', 'Value Tolerance', 0.5, 0.001, 1, { page: 'Key' }),
      F('softness', 'Edge Softness', 0.12, 0, 1, { page: 'Key' }),
      F('shrink', 'Shrink / Grow', 0, -1, 1, {
        page: 'Matte',
        help: 'Negative erodes the matte (kills fringes), positive dilates it (recovers lost detail).',
      }),
      F('spill', 'Spill Suppression', 0.5, 0, 1, { page: 'Matte' }),
      F('opacity', 'Opacity', 1, 0, 1, { page: 'Composite' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
/**
 * Returns keep-coverage for one foreground colour: 0 = fully keyed out.
 * HSV distance is normalised by the three tolerances, so the key region is an
 * ellipsoid in HSV and the scalar distance is 1.0 exactly at its surface.
 */
fn keyedcomposite_key(c: vec3f) -> f32 {
  let k = rgb2hsv(clamp(p_keycolor().rgb, vec3f(0.0), vec3f(1.0)));
  let h = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));

  var dh = abs(h.x - k.x);
  dh = min(dh, 1.0 - dh); // hue is a circle
  let ds = abs(h.y - k.y);
  let dv = abs(h.z - k.z);

  let ht = max(p_huetol(), 1.0e-4);
  let st = max(p_sattol(), 1.0e-4);
  let vt = max(p_valtol(), 1.0e-4);
  let d = length(vec3f(dh / ht, ds / st, dv / vt));

  // Desaturated pixels are far away on the saturation axis, so skin and hair
  // survive a saturated key without any extra special-casing.
  let s = max(p_softness(), 1.0e-4);
  return smoothstep(1.0, 1.0 + 2.0 * s, d);
}

/**
 * Erode / dilate by taking the min / max of the 3x3 neighbourhood. Radius
 * scales with the parameter so 0 collapses every tap onto the centre and the
 * whole thing becomes a no-op without needing a branch around the sampling.
 */
fn keyedcomposite_matte(uv: vec2f) -> f32 {
  let amount = clamp(p_shrink(), -1.0, 1.0);
  let rad = texel() * abs(amount) * 4.0;
  var lo = 1.0;
  var hi = 0.0;
  // Constant loop bounds keep the sampling inside uniform control flow.
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let o = vec2f(f32(x), f32(y)) * rad;
      let s = keyedcomposite_key(t1(clamp(uv + o, vec2f(0.0), vec2f(1.0))).rgb);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  return select(hi, lo, amount < 0.0);
}

/**
 * Pulls saturation out of colours sitting on the key hue, which is what removes
 * the green bounce on edges and shoulders. Works in HSV, so it clamps to 0..1
 * and out-of-range foregrounds lose their over-brights here.
 */
fn keyedcomposite_despill(c: vec3f) -> vec3f {
  let amount = clamp(p_spill(), 0.0, 1.0);
  if amount <= 1.0e-6 { return c; }
  let k = rgb2hsv(clamp(p_keycolor().rgb, vec3f(0.0), vec3f(1.0)));
  var h = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));
  var dh = abs(h.x - k.x);
  dh = min(dh, 1.0 - dh);
  let w = 1.0 - smoothstep(0.0, max(p_huetol() * 2.0, 1.0e-4), dh);
  h.y = h.y * (1.0 - amount * w);
  return hsv2rgb(h);
}

fn shade(uv: vec2f) -> vec4f {
  let bg = t0(uv);
  let raw = t1(uv);
  let m = keyedcomposite_matte(uv);

  // The key multiplies the foreground's existing coverage rather than replacing
  // it, so a foreground that already had alpha (a keyed render, a masked layer)
  // stays correct. Straight RGB is untouched: scaling alpha scales the
  // premultiplied contribution by exactly the same factor.
  let fg = vec4f(
    keyedcomposite_despill(raw.rgb),
    clamp(raw.a, 0.0, 1.0) * m * clamp(p_opacity(), 0.0, 1.0)
  );
  return overBlend(bg, fg);
}
`,
  }),

  // -------------------------------------------------------- difference-key ----
  top({
    id: 'difference-key',
    label: 'Difference Key',
    category: 'composite',
    runtime: 'shader',
    description: 'Keys the foreground by comparing it against a clean plate of the empty scene.',
    td: 'Difference Key (Chroma Key TOP alternative)',
    keywords: ['difference', 'key', 'clean plate', 'background subtraction', 'matte'],
    inputs: ['Foreground', 'Clean Plate'],
    params: [
      F('threshold', 'Threshold', 0.08, 0, 1, { page: 'Key' }),
      F('softness', 'Softness', 0.1, 0, 1, { page: 'Key' }),
      F('gain', 'Gain', 1, 0, 8, { page: 'Key' }),
      MENU('output', 'Output', 0, ['Keyed', 'Matte'], { page: 'Key' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
fn shade(uv: vec2f) -> vec4f {
  let fg = t0(uv);
  let plate = t1(uv);

  // Euclidean RGB distance scaled by 1/sqrt(3) so black-vs-white reads 1.0.
  let d = length(fg.rgb - plate.rgb) * 0.5773502692;
  let thr = clamp(p_threshold(), 0.0, 1.0);
  let s = max(clamp(p_softness(), 0.0, 1.0), 1.0e-4);
  let m = smoothstep(thr, thr + s, d * max(p_gain(), 0.0));

  // Matte multiplies existing coverage instead of replacing it, so this stacks
  // with an upstream key. RGB is left straight for the same reason as elsewhere.
  let keyed = vec4f(fg.rgb, clamp(fg.a, 0.0, 1.0) * m);
  let matte = vec4f(vec3f(m), 1.0);
  return select(keyed, matte, p_outputI() == 1);
}
`,
  }),

  // ------------------------------------------------------------ luma-blend ----
  top({
    id: 'luma-blend',
    label: 'Luma Blend',
    category: 'composite',
    runtime: 'shader',
    description: "Reveals the second input through the first input's own luminance, remapped and softened.",
    td: 'Luma Composite (Composite TOP + Luma Level TOP)',
    keywords: ['luma', 'luminance', 'blend', 'reveal', 'transition', 'brightness'],
    inputs: ['Input 1', 'Input 2'],
    params: [
      F('low', 'Luma Low', 0, 0, 1, { page: 'Luma' }),
      F('high', 'Luma High', 1, 0, 1, { page: 'Luma' }),
      BOOL('invert', 'Invert', false, { page: 'Luma' }),
      F('softness', 'Softness', 0, 0, 1, {
        page: 'Luma',
        help: 'Widens the low/high ramp on both sides.',
      }),
    ],
    shader: /* wgsl */ `${CX_LIB}
fn shade(uv: vec2f) -> vec4f {
  let base = t0(uv);
  let overlay = t1(uv);

  // min/max makes low > high behave as a swap rather than as NaN; the invert
  // switch is the intended way to flip the ramp.
  let s = clamp(p_softness(), 0.0, 1.0) * 0.5;
  let e0 = min(p_low(), p_high()) - s;
  let e1 = max(p_low(), p_high()) + s;
  var w = clamp((luma(base.rgb) - e0) / max(e1 - e0, 1.0e-4), 0.0, 1.0);
  w = w * w * (3.0 - 2.0 * w);
  if p_invertB() { w = 1.0 - w; }

  // The mask drives the overlay's COVERAGE, not a naive lerp. That way an
  // unwired second input (alpha 0) is a perfect pass-through, and the result
  // never fades toward transparent where the mask is high.
  return cx_blend(base, cx_opacity(overlay, w), 0);
}
`,
  }),

  // ------------------------------------------------------------------ wipe ----
  top({
    id: 'wipe',
    label: 'Wipe',
    category: 'composite',
    runtime: 'shader',
    description: 'Transitions between two inputs with a shaped, angled, soft-edged wipe.',
    td: 'Cross TOP / Composite TOP with a Ramp matte',
    keywords: ['wipe', 'transition', 'stripe', 'bars', 'iris', 'clock', 'radial'],
    inputs: ['Input 1', 'Input 2'],
    params: [
      F('position', 'Position', 0, 0, 1, { page: 'Wipe' }),
      MENU('shape', 'Shape', 0, ['Linear', 'Radial', 'Diagonal', 'Bars', 'Clock', 'Iris'], {
        page: 'Wipe',
      }),
      F('angle', 'Angle', 0, 0, 360, { page: 'Wipe', unit: 'deg' }),
      F('softness', 'Softness', 0.05, 0, 1, { page: 'Wipe' }),
      INT('bars', 'Bar Count', 8, 1, 32, { page: 'Wipe' }),
      BOOL('invert', 'Invert Direction', false, { page: 'Wipe' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
/**
 * Projection onto an arbitrary direction, normalised so the field still spans
 * exactly 0..1 across the frame at any angle and aspect ratio - otherwise a
 * 45 degree wipe would finish before Position reached 1.
 */
fn wipe_linear(uv: vec2f, dir: vec2f) -> f32 {
  let ar = max(U.aspect, 1.0e-4);
  let p = (uv - vec2f(0.5)) * vec2f(ar, 1.0);
  let range = 0.5 * (abs(dir.x) * ar + abs(dir.y));
  return clamp(dot(p, dir) / max(range, 1.0e-4) * 0.5 + 0.5, 0.0, 1.0);
}

/** 0 = revealed first, 1 = revealed last. */
fn wipe_field(uv: vec2f) -> f32 {
  let ang = radians(p_angle());
  let dir = vec2f(cos(ang), sin(ang));
  let ar = max(U.aspect, 1.0e-4);
  let p = centered(uv);

  switch p_shapeI() {
    case 1: {
      return clamp(length(p) / max(length(vec2f(ar, 1.0)), 1.0e-4), 0.0, 1.0);
    }
    case 2: {
      let d = vec2f(cos(ang + PI * 0.25), sin(ang + PI * 0.25));
      return wipe_linear(uv, d);
    }
    case 3: {
      let n = max(f32(p_barsI()), 1.0);
      let s = wipe_linear(uv, dir) * n;
      let cell = floor(s);
      let f = s - cell;
      // cell is integral, so fract(cell*0.5) is exactly 0.0 or 0.5. Alternating
      // the bar direction reads as venetian blinds rather than a comb.
      return select(f, 1.0 - f, fract(cell * 0.5) > 0.25);
    }
    case 4: {
      return fract((atan2(p.y, p.x) - ang) / TAU);
    }
    case 5: {
      let q = rot2(ang) * p;
      return clamp(max(abs(q.x) / ar, abs(q.y)), 0.0, 1.0);
    }
    default: {
      return wipe_linear(uv, dir);
    }
  }
}

fn shade(uv: vec2f) -> vec4f {
  var g = wipe_field(uv);
  if p_invertB() { g = 1.0 - g; }

  // Push the threshold half a soft-edge past both ends so Position 0 and 1 are
  // genuinely "all input 1" and "all input 2" instead of leaving a soft band.
  let s = max(clamp(p_softness(), 0.0, 1.0) * 0.5, 1.0e-4);
  let e = mix(-s, 1.0 + s, clamp(p_position(), 0.0, 1.0));
  let w = 1.0 - smoothstep(e - s, e + s, g);

  return cx_mixStraight(t0(uv), t1(uv), w);
}
`,
  }),

  // --------------------------------------------------------- feedback-mix ----
  top({
    id: 'feedback-mix',
    label: 'Feedback Mix',
    category: 'composite',
    runtime: 'shader',
    description:
      'Mixes a source into a decaying feedback frame with per-frame hue rotation, built for stable VJ feedback loops.',
    td: 'Feedback TOP + Composite TOP',
    keywords: ['feedback', 'trails', 'decay', 'persistence', 'echo', 'vj', 'rainbow'],
    inputs: ['Source', 'Feedback'],
    params: [
      F('persistence', 'Persistence', 0.9, 0, 1, {
        page: 'Feedback',
        help: 'How much of the previous frame survives. Below 1 the loop always decays to the source.',
      }),
      MENU('blend', 'Blend Mode', 0, BLEND_MODES, { page: 'Feedback' }),
      F('hueshift', 'Hue Shift / Frame', 0, -0.1, 0.1, {
        page: 'Feedback',
        help: 'Turns of hue applied to the feedback each frame. Accumulates through the loop, which is what makes feedback rainbows.',
      }),
      F('satdecay', 'Saturation Decay', 0, 0, 1, { page: 'Feedback' }),
      F('opacity', 'Source Opacity', 1, 0, 1, { page: 'Source' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
/**
 * Hue rotation and saturation decay applied ONCE per frame to the feedback
 * contribution. The cumulative rotation comes from the loop itself, so this
 * must not be scaled by U.frame or the shift would be counted twice.
 * HSV is an LDR model, so the input is clamped - over-brights in the feedback
 * path lose their headroom here rather than producing NaNs.
 */
fn feedbackmix_tone(c: vec3f) -> vec3f {
  let shift = clamp(p_hueshift(), -1.0, 1.0);
  let sd = clamp(p_satdecay(), 0.0, 1.0);
  if abs(shift) <= 1.0e-6 && sd <= 1.0e-6 { return c; }
  var hsv = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));
  hsv.x = fract(hsv.x + shift); // fract() is x - floor(x), so negatives wrap
  hsv.y = hsv.y * (1.0 - sd);
  return hsv2rgb(hsv);
}

/**
 * Modes that can only ever brighten. Feeding one of these back into itself is
 * an unbounded sum, so the source's contribution gets scaled by
 * (1 - persistence) below, turning the loop into a leaky integrator whose
 * fixed point is the source itself instead of white. Non-brightening modes
 * keep full strength.
 */
fn feedbackmix_accumulates(mode: i32) -> f32 {
  switch mode {
    case 1, 4, 8, 9, 13: { return 1.0; }
    default: { return 0.0; }
  }
}

fn shade(uv: vec2f) -> vec4f {
  let src = t0(uv);
  let fbRaw = t1(uv);
  let mode = p_blendI();
  let persistence = clamp(p_persistence(), 0.0, 1.0);

  // Decaying COVERAGE (not RGB) is what makes trails fade out to transparent
  // instead of sliding toward grey: in premultiplied terms alpha *= k scales
  // the whole contribution by k while leaving the colour identity alone.
  let fb = vec4f(feedbackmix_tone(fbRaw.rgb), clamp(fbRaw.a, 0.0, 1.0) * persistence);

  // Stability, part 1: leaky-integrator weighting for the brightening modes.
  // The attenuation goes on the source's RGB - the energy it adds - and NOT on
  // its alpha. Scaling coverage instead would make an opaque source turn 90%
  // transparent at persistence 0.9, and the trails would then have to fight to
  // build coverage back up. With sum p*C + (1-p)*S the fixed point is exactly
  // the source colour, so bright sources settle instead of climbing to white.
  let leak = mix(1.0, 1.0 - persistence, feedbackmix_accumulates(mode));
  let fg = cx_opacity(vec4f(src.rgb * leak, src.a), p_opacity());

  let mixed = cx_blend(fb, fg, mode);

  // Stability, part 2: a hue-preserving ceiling at 1.0. Any residual gain in
  // the loop (divide, dodge, a hand-wired amplifier upstream) is clipped by
  // brightness only, so the worst case is a saturated frame - never an
  // exploding one - and hue is never twisted by per-channel clamping.
  return vec4f(cx_normalize(mixed.rgb), mixed.a);
}
`,
  }),

  // ----------------------------------------------------------- channel-mix ----
  top({
    id: 'channel-mix',
    label: 'Channel Mix',
    category: 'composite',
    runtime: 'shader',
    description: 'Rebuilds RGBA by picking each output channel from any channel of either input.',
    td: 'Reorder TOP',
    keywords: ['channel', 'reorder', 'swizzle', 'shuffle', 'remap', 'rgba'],
    inputs: ['Input 1', 'Input 2'],
    params: [
      MENU('red', 'Red From', 0, CHANNEL_SOURCES, { page: 'Channels' }),
      MENU('green', 'Green From', 1, CHANNEL_SOURCES, { page: 'Channels' }),
      MENU('blue', 'Blue From', 2, CHANNEL_SOURCES, { page: 'Channels' }),
      MENU('alpha', 'Alpha From', 3, CHANNEL_SOURCES, { page: 'Channels' }),
    ],
    shader: /* wgsl */ `${CX_LIB}
/**
 * Both inputs are sampled once by the caller and the twelve candidates are
 * gathered into a var array, so the menu index is a plain dynamic array read.
 * Nothing is sampled inside a branch, which is what keeps textureSample out of
 * non-uniform control flow.
 */
fn channelmix_pick(c1: vec4f, c2: vec4f, sel: i32) -> f32 {
  var v = array<f32, 12>(
    c1.r, c1.g, c1.b, c1.a, luma(c1.rgb),
    c2.r, c2.g, c2.b, c2.a, luma(c2.rgb),
    0.0, 1.0
  );
  return v[clamp(sel, 0, 11)];
}

fn shade(uv: vec2f) -> vec4f {
  let c1 = t0(uv);
  let c2 = t1(uv);

  // Straight-alpha in, straight-alpha out: routing a colour channel into alpha
  // (or vice versa) is a pure channel move here. If the alpha ends up lower
  // than before, the RGB under it is preserved rather than crushed, so a
  // following Composite can still grow the matte.
  return vec4f(
    channelmix_pick(c1, c2, p_redI()),
    channelmix_pick(c1, c2, p_greenI()),
    channelmix_pick(c1, c2, p_blueI()),
    channelmix_pick(c1, c2, p_alphaI())
  );
}
`,
  }),
]
