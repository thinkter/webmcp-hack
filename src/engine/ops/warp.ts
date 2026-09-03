/**
 * Warp operators — everything that moves pixels around without inventing new
 * colour: transforms, tiling, mirrors, polar remaps, lens distortion, and
 * displacement.
 *
 * Two rules run through the whole file.
 *
 * 1. Every warp computes a *sampling* coordinate, so any chain of operations
 *    the user thinks of as "move the image" has to be applied in reverse.
 *    See `transform` for the fully worked example.
 * 2. Anything angular (rotation, polar, radial falloff) works in the
 *    aspect-corrected space of `centered()` / `uncentered()`, where one unit is
 *    half the frame height on both axes. That keeps circles circular on a 16:9
 *    frame. Purely axis-aligned warps stay in uv space, but their X
 *    displacement is divided by `U.aspect` so an X and a Y amount of equal
 *    magnitude read as the same on-screen distance.
 */

import { BOOL, COLOR, F, INT, MENU, top } from './kit'
import type { OperatorSpec } from './kit'

/** Shared extend-mode menu: 0 hold edge, 1 transparent, 2 repeat, 3 mirror. */
const EXTEND = (page = 'Extend') =>
  MENU('extend', 'Extend', 0, ['Hold', 'Transparent', 'Repeat', 'Mirror'], { page })

export const warpOperators: OperatorSpec[] = [
  // ------------------------------------------------------------- transform ----
  top({
    id: 'transform',
    label: 'Transform',
    category: 'warp',
    runtime: 'shader',
    description:
      'Translates, scales, rotates and flips the input about an arbitrary pivot, exactly like a Transform TOP.',
    td: 'Transform TOP',
    keywords: ['transform', 'move', 'translate', 'scale', 'rotate', 'flip', 'pivot', 'srt'],
    inputs: ['Texture'],
    params: [
      F('translatex', 'Translate X', 0, -2, 2, { page: 'Transform' }),
      F('translatey', 'Translate Y', 0, -2, 2, { page: 'Transform' }),
      F('scalex', 'Scale X', 1, 0, 4, { page: 'Transform' }),
      F('scaley', 'Scale Y', 1, 0, 4, { page: 'Transform' }),
      BOOL('uniformscale', 'Uniform Scale', false, {
        page: 'Transform',
        help: 'Scale Y follows Scale X.',
      }),
      F('rotate', 'Rotate', 0, -1, 1, {
        page: 'Transform',
        unit: 'turns',
        help: '-1..1 is one full turn each way; positive is counter-clockwise.',
      }),
      F('pivotx', 'Pivot X', 0.5, -1, 2, { page: 'Pivot' }),
      F('pivoty', 'Pivot Y', 0.5, -1, 2, { page: 'Pivot' }),
      BOOL('fliph', 'Flip Horizontal', false, { page: 'Flip' }),
      BOOL('flipv', 'Flip Vertical', false, { page: 'Flip' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  // Pivot supplied in uv units, used in aspect-corrected centred space.
  let piv = centered(vec2f(p_pivotx(), p_pivoty()));

  let sx = p_scalex();
  let sy = select(p_scaley(), sx, p_uniformscaleB());
  let scale = max(vec2f(sx, sy), vec2f(1.0e-4));

  // Translate arrives in uv units; a uv delta of 1 is a centred delta of
  // 2*aspect on X and 2 on Y. Y is negated because the user thinks of +Y as up
  // while uv (and therefore centred space) counts Y downwards.
  let tr = vec2f(p_translatex() * U.aspect, -p_translatey()) * 2.0;

  let theta = p_rotate() * TAU;
  let flip = vec2f(
    select(1.0, -1.0, p_fliphB()),
    select(1.0, -1.0, p_flipvB())
  );

  // The user-facing chain is  flip -> scale(pivot) -> rotate(pivot) -> translate.
  // We move the sampling coordinate, so we walk that chain backwards and invert
  // each step: subtract the translation, rotate by -theta, divide by the scale,
  // and re-apply the flip (a reflection is its own inverse).
  var p = centered(uv) - tr;
  p = rot2(-theta) * (p - piv) + piv;
  p = (p - piv) / scale + piv;
  p = (p - piv) * flip + piv;

  let src = uncentered(p);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // ------------------------------------------------------------------ crop ----
  top({
    id: 'crop',
    label: 'Crop',
    category: 'warp',
    runtime: 'shader',
    description:
      'Trims a fraction off each edge, either masking the discarded region away or zooming the remainder back up to fill the frame.',
    td: 'Crop TOP',
    keywords: ['crop', 'trim', 'cut', 'window', 'zoom', 'fit'],
    inputs: ['Texture'],
    params: [
      F('left', 'Left', 0, 0, 1, { page: 'Crop', help: 'Fraction removed from the left edge.' }),
      F('right', 'Right', 0, 0, 1, { page: 'Crop', help: 'Fraction removed from the right edge.' }),
      F('top', 'Top', 0, 0, 1, { page: 'Crop', help: 'Fraction removed from the top edge.' }),
      F('bottom', 'Bottom', 0, 0, 1, {
        page: 'Crop',
        help: 'Fraction removed from the bottom edge.',
      }),
      MENU('mode', 'Mode', 0, ['Mask', 'Zoom to Fit'], { page: 'Crop' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  // Each parameter is the fraction eaten from that edge, so the kept window is
  // [left, 1-right] x [top, 1-bottom].
  let x0 = clamp(p_left(), 0.0, 1.0);
  let x1 = 1.0 - clamp(p_right(), 0.0, 1.0);
  let y0 = clamp(p_top(), 0.0, 1.0);
  let y1 = 1.0 - clamp(p_bottom(), 0.0, 1.0);

  // Sort and de-degenerate so over-cropping cannot divide by zero in Zoom mode.
  let lo = vec2f(min(x0, x1), min(y0, y1));
  let hi = max(vec2f(max(x0, x1), max(y0, y1)), lo + vec2f(1.0e-3));
  let size = hi - lo;

  let zoom = p_modeI() == 1;
  let zoomUv = lo + uv * size;
  let src = select(uv, zoomUv, zoom);

  // One unconditional sample; the branch only picks the coordinate.
  let c = t0(clamp(src, vec2f(0.0), vec2f(1.0)));

  // Hard-edged mask: step() keeps the default (uncropped) case exactly 1.0 all
  // the way to the frame border, which a smoothstep would fade.
  let m = step(lo.x, uv.x) * step(uv.x, hi.x) * step(lo.y, uv.y) * step(uv.y, hi.y);
  return c * select(m, 1.0, zoom);
}
`,
  }),

  // ------------------------------------------------------------------ tile ----
  top({
    id: 'tile',
    label: 'Tile',
    category: 'warp',
    runtime: 'shader',
    description:
      'Repeats the input across the frame in a grid, optionally mirroring or quarter-turning alternate cells for a seamless quilt.',
    td: 'Tile TOP',
    keywords: ['tile', 'repeat', 'grid', 'array', 'quilt', 'wallpaper'],
    inputs: ['Texture'],
    params: [
      INT('repeatx', 'Repeat X', 2, 1, 16, { page: 'Tile' }),
      INT('repeaty', 'Repeat Y', 2, 1, 16, { page: 'Tile' }),
      F('offsetx', 'Offset X', 0, -1, 1, { page: 'Tile', help: 'In frame widths.' }),
      F('offsety', 'Offset Y', 0, -1, 1, { page: 'Tile', help: 'In frame heights.' }),
      BOOL('mirror', 'Mirror Alternate', false, { page: 'Alternate' }),
      BOOL('rotate', 'Rotate Alternate', false, { page: 'Alternate' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let rep = vec2f(f32(max(p_repeatxI(), 1)), f32(max(p_repeatyI(), 1)));
  let q = (uv + vec2f(p_offsetx(), p_offsety())) * rep;
  let cell = floor(q);
  var f = fract(q);

  // WGSL fract() is floor-based, so this parity test stays correct for the
  // negative cell indices produced by a negative offset.
  let par = fract(cell * 0.5) * 2.0;

  let mirrorX = p_mirrorB() && (par.x > 0.5);
  let mirrorY = p_mirrorB() && (par.y > 0.5);
  f = vec2f(
    select(f.x, 1.0 - f.x, mirrorX),
    select(f.y, 1.0 - f.y, mirrorY)
  );

  // Quarter turn inside the tile on a checkerboard of cells.
  let odd = p_rotateB() && (fract((cell.x + cell.y) * 0.5) * 2.0 > 0.5);
  f = select(f, vec2f(f.y, 1.0 - f.x), odd);

  return t0(clamp(f, vec2f(0.0), vec2f(1.0)));
}
`,
  }),

  // ---------------------------------------------------------- kaleidoscope ----
  top({
    id: 'kaleidoscope',
    label: 'Kaleidoscope',
    category: 'warp',
    runtime: 'shader',
    description:
      'Folds a single wedge of the input around a centre point into a mirrored, seamless radial pattern.',
    td: 'Kaleidoscope (Polar TOP + Mirror TOP)',
    keywords: ['kaleidoscope', 'mandala', 'radial', 'mirror', 'segments', 'wedge', 'symmetry'],
    inputs: ['Texture'],
    params: [
      INT('segments', 'Segments', 6, 2, 24, { page: 'Kaleidoscope' }),
      F('rotation', 'Rotation', 0, -1, 1, {
        page: 'Kaleidoscope',
        unit: 'turns',
        help: 'Spins the pattern.',
      }),
      F('sourcerotate', 'Source Rotation', 0, -1, 1, {
        page: 'Kaleidoscope',
        unit: 'turns',
        help: 'Spins which slice of the input feeds each wedge.',
      }),
      F('zoom', 'Zoom', 1, 0.05, 4, { page: 'Kaleidoscope' }),
      F('centrex', 'Centre X', 0.5, -1, 2, { page: 'Centre' }),
      F('centrey', 'Centre Y', 0.5, -1, 2, { page: 'Centre' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let ctr = centered(vec2f(p_centrex(), p_centrey()));
  let p = centered(uv) - ctr;
  let seg = TAU / f32(max(p_segmentsI(), 2));

  let r = length(p) / max(p_zoom(), 1.0e-4);
  var a = atan2(p.y, p.x) - p_rotation() * TAU;

  // Wrap into one wedge, then mirror-fold about the wedge centre. The fold is
  // what makes the mapping continuous across a shared wedge edge: both sides
  // approach the same source angle, so no seam appears.
  a = a - seg * floor(a / seg);
  a = abs(a - seg * 0.5);

  a = a + p_sourcerotate() * TAU;
  let src = uncentered(vec2f(cos(a), sin(a)) * r + ctr);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // ---------------------------------------------------------------- mirror ----
  top({
    id: 'mirror',
    label: 'Mirror',
    category: 'warp',
    runtime: 'shader',
    description:
      'Reflects one half of the frame onto the other across a horizontal, vertical, quad or 45-degree diagonal split.',
    td: 'Mirror TOP',
    keywords: ['mirror', 'reflect', 'flip', 'symmetry', 'quad', 'diagonal'],
    inputs: ['Texture'],
    params: [
      MENU('axis', 'Axis', 0, ['Horizontal', 'Vertical', 'Quad', 'Diagonal'], { page: 'Mirror' }),
      F('split', 'Split', 0.5, 0, 1, { page: 'Mirror', help: 'Position of the mirror line.' }),
      BOOL('flipside', 'Flip Side', false, {
        page: 'Mirror',
        help: 'Keep the other half instead.',
      }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let s = p_split();
  let flip = p_flipsideB();
  var src = uv;

  switch p_axisI() {
    case 1: {
      let doY = select(uv.y > s, uv.y < s, flip);
      src.y = select(src.y, 2.0 * s - uv.y, doY);
    }
    case 2: {
      let doX = select(uv.x > s, uv.x < s, flip);
      src.x = select(src.x, 2.0 * s - uv.x, doX);
      let doY = select(uv.y > s, uv.y < s, flip);
      src.y = select(src.y, 2.0 * s - uv.y, doY);
    }
    case 3: {
      // Reflect across the 45-degree line  p.y - p.x = k  in aspect-corrected
      // space. With unit normal n = (-1,1)/sqrt(2) and signed distance
      // d = (p.y - p.x - k)/sqrt(2), the reflection p - 2*d*n collapses to a
      // component swap plus the offset: (p.y - k, p.x + k).
      let k = (s - 0.5) * 2.0;
      let p = centered(uv);
      let side = select(p.y - p.x > k, p.y - p.x < k, flip);
      src = select(src, uncentered(vec2f(p.y - k, p.x + k)), side);
    }
    default: {
      let doX = select(uv.x > s, uv.x < s, flip);
      src.x = select(src.x, 2.0 * s - uv.x, doX);
    }
  }

  // A split away from 0.5 (or any diagonal fold on a non-square frame) can
  // reflect outside the frame; hold the edge there.
  return t0(clamp(src, vec2f(0.0), vec2f(1.0)));
}
`,
  }),

  // ----------------------------------------------------------------- polar ----
  top({
    id: 'polar',
    label: 'Polar',
    category: 'warp',
    runtime: 'shader',
    description:
      'Converts between cartesian and polar coordinates, unwrapping a disc into a strip or wrapping a strip around a circle.',
    td: 'Polar TOP',
    keywords: ['polar', 'cartesian', 'unwrap', 'radial', 'angle', 'radius', 'tunnel'],
    inputs: ['Texture'],
    params: [
      MENU('direction', 'Direction', 0, ['To Polar', 'From Polar'], { page: 'Polar' }),
      F('angle', 'Angle Offset', 0, -1, 1, { page: 'Polar', unit: 'turns' }),
      F('radiusscale', 'Radius Scale', 1, 0.05, 4, { page: 'Polar' }),
      F('radiusoffset', 'Radius Offset', 0, -1, 1, { page: 'Polar' }),
      F('centrex', 'Centre X', 0.5, -1, 2, { page: 'Centre' }),
      F('centrey', 'Centre Y', 0.5, -1, 2, { page: 'Centre' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let ctr = centered(vec2f(p_centrex(), p_centrey()));
  let off = p_angle();
  let rscale = max(p_radiusscale(), 1.0e-4);
  let roff = p_radiusoffset();

  // To Polar: the output's X axis is angle and its Y axis is radius, so the
  // disc around the centre is unwrapped into a full-frame strip. Radius is in
  // centred units, where 1.0 reaches the top and bottom of the frame.
  let ang = (uv.x - 0.5 + off) * TAU;
  let rad = uv.y * rscale + roff;
  let toPolar = uncentered(vec2f(cos(ang), sin(ang)) * rad + ctr);

  // From Polar: the exact algebraic inverse of the above, so chaining the two
  // directions with matching parameters is a no-op.
  let p = centered(uv) - ctr;
  let fromPolar = vec2f(
    atan2(p.y, p.x) / TAU + 0.5 - off,
    (length(p) - roff) / rscale
  );

  let src = select(toPolar, fromPolar, p_directionI() == 1);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // ----------------------------------------------------------------- twirl ----
  top({
    id: 'twirl',
    label: 'Twirl',
    category: 'warp',
    runtime: 'shader',
    description:
      'Spirals the image around a centre point, with the rotation easing smoothly to zero at the given radius.',
    td: 'Twirl TOP',
    keywords: ['twirl', 'swirl', 'spiral', 'vortex', 'whirl', 'rotate'],
    inputs: ['Texture'],
    params: [
      F('strength', 'Strength', 0.25, -2, 2, { page: 'Twirl', unit: 'turns' }),
      F('radius', 'Radius', 0.8, 0, 2, {
        page: 'Twirl',
        help: '1.0 reaches the top and bottom of the frame.',
      }),
      F('falloff', 'Falloff', 1, 0.1, 6, { page: 'Twirl' }),
      F('centrex', 'Centre X', 0.5, -1, 2, { page: 'Centre' }),
      F('centrey', 'Centre Y', 0.5, -1, 2, { page: 'Centre' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let ctr = centered(vec2f(p_centrex(), p_centrey()));
  let p = centered(uv) - ctr;
  let rad = max(p_radius(), 1.0e-4);

  let t = clamp(1.0 - length(p) / rad, 0.0, 1.0);
  // Smoothstep the ramp before shaping it with the exponent: pow() alone has a
  // kink at r == radius for exponent 1, whereas smoothstep is C1 at both ends
  // for any exponent > 0.
  let s = t * t * (3.0 - 2.0 * t);
  let fall = pow(s, max(p_falloff(), 1.0e-3));

  // Rotating the sampling coordinate by -theta rotates the image by +theta.
  let theta = p_strength() * TAU * fall;
  let src = uncentered(rot2(-theta) * p + ctr);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // --------------------------------------------------------------- fisheye ----
  top({
    id: 'fisheye',
    label: 'Fisheye',
    category: 'warp',
    runtime: 'shader',
    description:
      'Applies radial lens distortion with optional chromatic aberration: negative strength bulges like a barrel, positive pinches like a pincushion.',
    td: 'Fisheye TOP / Lens Distort TOP',
    keywords: ['fisheye', 'lens', 'barrel', 'pincushion', 'distort', 'chromatic', 'aberration'],
    inputs: ['Texture'],
    params: [
      F('strength', 'Strength', -0.3, -1, 1, {
        page: 'Lens',
        help: 'Negative = barrel, positive = pincushion.',
      }),
      F('zoom', 'Zoom', 1, 0.1, 4, { page: 'Lens' }),
      F('chroma', 'Chromatic Aberration', 0, 0, 1, { page: 'Lens' }),
      F('centrex', 'Centre X', 0.5, -1, 2, { page: 'Centre' }),
      F('centrey', 'Centre Y', 0.5, -1, 2, { page: 'Centre' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let ctr = centered(vec2f(p_centrex(), p_centrey()));
  let p = (centered(uv) - ctr) / max(p_zoom(), 1.0e-4);

  // Normalise r^2 so the frame corner sits at 1.0. That keeps the distortion
  // multiplier inside [0,2] over the whole strength range, so the sampling
  // coordinate can never change sign and mirror the corners.
  let corner = vec2f(U.aspect, 1.0);
  let r2 = dot(p, p) / dot(corner, corner);

  // Local magnification of r -> r*(1 + k*r^2) is 1/(1 + 3*k*r^2), so k > 0
  // magnifies the centre (barrel). The user-facing sign is the opposite.
  let k = -p_strength();
  let base = 1.0 + k * r2;
  let ca = p_chroma() * 0.15;

  // Sample all three channels unconditionally; only the radius differs.
  let mode = p_extendI();
  let sr = uncentered(p * (base + ca * r2) + ctr);
  let sg = uncentered(p * base + ctr);
  let sb = uncentered(p * (base - ca * r2) + ctr);

  let cr = t0(extendUv(sr, mode)) * extendMask(sr, mode);
  let cg = t0(extendUv(sg, mode)) * extendMask(sg, mode);
  let cb = t0(extendUv(sb, mode)) * extendMask(sb, mode);
  return vec4f(cr.r, cg.g, cb.b, cg.a);
}
`,
  }),

  // ------------------------------------------------------------- wave warp ----
  top({
    id: 'wave-warp',
    label: 'Wave Warp',
    category: 'warp',
    runtime: 'shader',
    description:
      'Ripples the image with a sine, triangle, square or noise wave, animated over time.',
    td: 'Wave TOP (as a displacement) / Warp TOP',
    keywords: ['wave', 'warp', 'ripple', 'wobble', 'sine', 'triangle', 'square', 'noise'],
    inputs: ['Texture'],
    params: [
      F('amplitudex', 'Amplitude X', 0.03, -0.5, 0.5, { page: 'Wave' }),
      F('amplitudey', 'Amplitude Y', 0.03, -0.5, 0.5, { page: 'Wave' }),
      F('frequencyx', 'Frequency X', 4, 0, 32, { page: 'Wave' }),
      F('frequencyy', 'Frequency Y', 4, 0, 32, { page: 'Wave' }),
      F('phase', 'Phase', 0, -1, 1, { page: 'Wave', unit: 'cycles' }),
      F('speed', 'Speed', 0.2, -4, 4, { page: 'Wave', unit: 'cycles/s' }),
      MENU('waveform', 'Waveform', 0, ['Sine', 'Triangle', 'Square', 'Noise'], { page: 'Wave' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
// All four waveforms return [-1,1] and agree with sin(x*TAU) at x = 0, 0.25,
// 0.5, 0.75, so switching waveform does not jump the phase.
fn wavewarp_osc(x: f32, kind: i32) -> f32 {
  switch kind {
    case 1: { return 1.0 - abs(fract(x + 0.25) * 4.0 - 2.0); }
    case 2: { return select(-1.0, 1.0, fract(x) < 0.5); }
    case 3: { return snoise(vec2f(x, 0.0)); }
    default: { return sin(x * TAU); }
  }
}

fn shade(uv: vec2f) -> vec4f {
  let kind = p_waveformI();
  let t = p_phase() + U.time * p_speed();

  // X displacement varies along Y and vice versa, so the frame ripples instead
  // of sliding rigidly.
  let dx = p_amplitudex() * wavewarp_osc(uv.y * p_frequencyx() + t, kind);
  let dy = p_amplitudey() * wavewarp_osc(uv.x * p_frequencyy() + t, kind);

  // Amplitudes are in frame heights; divide X by aspect so equal amplitudes
  // are equal on-screen distances.
  let src = uv + vec2f(dx / U.aspect, dy);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // -------------------------------------------------------------- displace ----
  top({
    id: 'displace',
    label: 'Displace',
    category: 'warp',
    runtime: 'shader',
    description:
      "Offsets the first input's sampling coordinate using channels of the second input, where mid-grey means no movement.",
    td: 'Displace TOP',
    keywords: ['displace', 'displacement', 'map', 'offset', 'distort', 'uv'],
    inputs: ['Texture', 'Displace'],
    params: [
      F('amountx', 'Amount X', 0.1, -1, 1, { page: 'Displace' }),
      F('amounty', 'Amount Y', 0.1, -1, 1, { page: 'Displace' }),
      MENU('sourcex', 'Source X', 0, ['Red', 'Green', 'Blue', 'Alpha', 'Luminance'], {
        page: 'Displace',
      }),
      MENU('sourcey', 'Source Y', 1, ['Red', 'Green', 'Blue', 'Alpha', 'Luminance'], {
        page: 'Displace',
      }),
      F('bias', 'Bias', 0.5, -1, 1, {
        page: 'Displace',
        help: 'Displace-map value that means "no displacement".',
      }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn displace_chan(c: vec4f, which: i32) -> f32 {
  switch which {
    case 1: { return c.g; }
    case 2: { return c.b; }
    case 3: { return c.a; }
    case 4: { return luma(c.rgb); }
    default: { return c.r; }
  }
}

fn shade(uv: vec2f) -> vec4f {
  let d = t1(uv);
  let bias = p_bias();
  let dx = (displace_chan(d, p_sourcexI()) - bias) * p_amountx();
  let dy = (displace_chan(d, p_sourceyI()) - bias) * p_amounty();

  // Amounts are in frame heights; X is aspect-corrected so a grey ramp on both
  // axes pushes the same visible distance.
  let src = uv + vec2f(dx / U.aspect, dy);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // ------------------------------------------------------------- flow warp ----
  top({
    id: 'flow-warp',
    label: 'Flow Warp',
    category: 'warp',
    runtime: 'shader',
    description:
      'Drags the image along an animated fbm flow field for smoke-like, self-advecting motion with no displacement map needed.',
    td: 'Displace TOP driven by a Noise TOP',
    keywords: ['flow', 'warp', 'curl', 'fbm', 'noise', 'turbulence', 'smoke', 'advect', 'lookup'],
    inputs: ['Texture'],
    params: [
      F('amount', 'Amount', 0.25, 0, 1, { page: 'Flow' }),
      F('scale', 'Scale', 2, 0.1, 12, { page: 'Flow' }),
      F('speed', 'Speed', 0.15, -2, 2, { page: 'Flow' }),
      INT('octaves', 'Octaves', 3, 1, 6, { page: 'Flow' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn flowwarp_potential(p: vec2f, oct: i32) -> f32 {
  return fbm(p, oct, 2.0, 0.5);
}

fn shade(uv: vec2f) -> vec4f {
  let oct = clamp(p_octavesI(), 1, 6);
  let scale = max(p_scale(), 1.0e-3);

  // Drifting the noise domain animates the field without popping.
  let drift = U.time * p_speed() * vec2f(0.13, -0.21);
  let p = centered(uv) * scale + drift;

  // Displace along the curl of a scalar fbm potential. A curl field is
  // divergence-free, so the image shears and swirls rather than pooling into or
  // draining out of sinks the way a raw noise offset does.
  let e = 0.035;
  let n0 = flowwarp_potential(p, oct);
  let nx = flowwarp_potential(p + vec2f(e, 0.0), oct);
  let ny = flowwarp_potential(p + vec2f(0.0, e), oct);
  let grad = vec2f(nx - n0, ny - n0) / e;
  let flow = vec2f(-grad.y, grad.x);

  // The gradient of an fbm is unbounded in principle; clamp so a high octave
  // count cannot fling the lookup across the frame.
  let disp = clamp(flow * p_amount() * 0.15, vec2f(-0.5), vec2f(0.5));
  let src = uv + vec2f(disp.x / U.aspect, disp.y);
  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // ----------------------------------------------------------- perspective ----
  top({
    id: 'perspective',
    label: 'Perspective',
    category: 'warp',
    runtime: 'shader',
    description:
      'Corner-pins the frame by dragging its four corners, using a true perspective (projective) warp rather than a bilinear stretch.',
    td: 'Corner Pin TOP',
    keywords: ['perspective', 'corner pin', 'cornerpin', 'homography', 'projective', 'keystone'],
    inputs: ['Texture'],
    params: [
      F('topleftx', 'Top-Left X', 0, -1, 1, { page: 'Top' }),
      F('toplefty', 'Top-Left Y', 0, -1, 1, { page: 'Top' }),
      F('toprightx', 'Top-Right X', 0, -1, 1, { page: 'Top' }),
      F('toprighty', 'Top-Right Y', 0, -1, 1, { page: 'Top' }),
      F('botrightx', 'Bottom-Right X', 0, -1, 1, { page: 'Bottom' }),
      F('botrighty', 'Bottom-Right Y', 0, -1, 1, { page: 'Bottom' }),
      F('botleftx', 'Bottom-Left X', 0, -1, 1, { page: 'Bottom' }),
      F('botlefty', 'Bottom-Left Y', 0, -1, 1, { page: 'Bottom' }),
      EXTEND(),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  // Destination quad in uv space: each frame corner plus its offset. Offsets are
  // in uv units (fractions of width / height), which is the usual corner-pin
  // convention, so they are deliberately NOT aspect-corrected.
  let c0 = vec2f(0.0, 0.0) + vec2f(p_topleftx(),   p_toplefty());
  let c1 = vec2f(1.0, 0.0) + vec2f(p_toprightx(),  p_toprighty());
  let c2 = vec2f(1.0, 1.0) + vec2f(p_botrightx(),  p_botrighty());
  let c3 = vec2f(0.0, 1.0) + vec2f(p_botleftx(),   p_botlefty());

  // ---- Forward homography: unit square -> quad (Heckbert, square-to-quad).
  // We want coefficients for
  //   x = (a*u + b*v + c) / (g*u + h*v + 1)
  //   y = (d*u + e*v + f) / (g*u + h*v + 1)
  // with (0,0)->c0, (1,0)->c1, (1,1)->c2, (0,1)->c3.
  //
  // s is zero exactly when the quad is a parallelogram, in which case g and h
  // fall out as zero and the map degrades to an affine one - so no special-case
  // branch is needed. The default (all offsets zero) runs through here and
  // yields the identity matrix.
  let s = c0 - c1 + c2 - c3;
  let d1 = c1 - c2;
  let d2 = c3 - c2;

  let den0 = d1.x * d2.y - d1.y * d2.x;
  // den is zero only for a collapsed/collinear quad, which has no homography at
  // all; nudge it so the frame goes weird instead of NaN.
  let den = select(den0, 1.0e-6, abs(den0) < 1.0e-6);

  let g = (s.x * d2.y - s.y * d2.x) / den;
  let h = (d1.x * s.y - d1.y * s.x) / den;
  let a = c1.x - c0.x + g * c1.x;
  let b = c3.x - c0.x + h * c3.x;
  let c = c0.x;
  let dm = c1.y - c0.y + g * c1.y;
  let e = c3.y - c0.y + h * c3.y;
  let f = c0.y;

  // ---- Inverse homography: quad -> unit square.
  // We sample the source, so we need to go from the pixel we are shading back
  // to a source uv, i.e. the inverse of
  //   M = [ a b c ]
  //       [ d e f ]
  //       [ g h 1 ]
  // The adjugate is enough: 1/det is a common factor of the numerator and the
  // denominator, so it cancels in the perspective divide.
  let iA = e  - f * h;
  let iB = c  * h - b;
  let iC = b  * f - c * e;
  let iD = f  * g - dm;
  let iE = a  - c * g;
  let iF = c  * dm - a * f;
  let iG = dm * h - e * g;
  let iH = b  * g - a * h;
  let iI = a  * e - b * dm;

  let w0 = iG * uv.x + iH * uv.y + iI;
  let w = select(w0, 1.0e-6, abs(w0) < 1.0e-6);
  let src = vec2f(
    (iA * uv.x + iB * uv.y + iC) / w,
    (iD * uv.x + iE * uv.y + iF) / w
  );

  let mode = p_extendI();
  return t0(extendUv(src, mode)) * extendMask(src, mode);
}
`,
  }),

  // ---------------------------------------------------------------- border ----
  top({
    id: 'border',
    label: 'Border',
    category: 'warp',
    runtime: 'shader',
    description:
      'Draws a soft, optionally rounded border around the frame, either over the image or by squeezing the image inside it.',
    td: 'Border TOP',
    keywords: ['border', 'frame', 'edge', 'outline', 'stroke', 'rounded', 'matte'],
    inputs: ['Texture'],
    params: [
      F('width', 'Width', 0.04, 0, 0.5, { page: 'Border', help: 'In frame heights.' }),
      F('softness', 'Softness', 0.004, 0, 0.25, { page: 'Border' }),
      COLOR('bordercolor', 'Border Color', [1, 1, 1, 1], { page: 'Border' }),
      MENU('style', 'Style', 0, ['Inside', 'Outside', 'Centred'], {
        page: 'Border',
        help: 'Where the band sits relative to the image: over it, beside it, or straddling it.',
      }),
      F('radius', 'Corner Radius', 0, 0, 0.5, { page: 'Border', help: 'In frame heights.' }),
    ],
    shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  // Frame half-extents in centred units: X is aspect, Y is always 1.
  let halfExt = vec2f(U.aspect, 1.0);
  let p = centered(uv);

  // Widths and radii are authored as fractions of the frame height; centred
  // units are half-heights, hence the doubling.
  let w = max(p_width(), 0.0) * 2.0;
  let soft = max(p_softness(), 0.0) * 2.0 + 1.0e-4;

  // The band always occupies the same place (the outer w of the frame). Style
  // decides how far the image is pulled in from the frame edge, which is what
  // makes Inside cover the image, Outside clear of it, and Centred straddle it.
  var inset = 0.0;
  switch p_styleI() {
    case 1: { inset = w; }
    case 2: { inset = w * 0.5; }
    default: { inset = 0.0; }
  }

  let fit = max(halfExt - vec2f(inset), vec2f(1.0e-3));
  let src = uncentered(p * halfExt / fit);
  var img = t0(clamp(src, vec2f(0.0), vec2f(1.0)));
  // Outside its squeezed rect the image is transparent, not edge-held.
  let inside = step(0.0, src.x) * step(src.x, 1.0) * step(0.0, src.y) * step(src.y, 1.0);
  img = vec4f(img.rgb, img.a * inside);

  let rOuter = clamp(p_radius() * 2.0, 0.0, min(halfExt.x, halfExt.y));
  let dOuter = sdBox(p, halfExt, rOuter);
  let dInner = sdBox(p, max(halfExt - vec2f(w), vec2f(1.0e-3)), max(rOuter - w, 0.0));

  let aOuter = 1.0 - smoothstep(-soft, soft, dOuter); // 1 inside the outer rect
  let aInner = smoothstep(-soft, soft, dInner);       // 1 outside the inner rect
  let band = aOuter * aInner;

  let col = p_bordercolor();
  let comp = overBlend(img, vec4f(col.rgb, col.a * band));
  // Cut the rounded corners out of the composite. Alpha only: the colours are
  // non-premultiplied.
  return vec4f(comp.rgb, comp.a * aOuter);
}
`,
  }),
]
