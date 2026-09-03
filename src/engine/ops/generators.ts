/**
 * Procedural texture generators.
 *
 * These are the operators that produce an image from nothing, so they are the
 * usual starting point for a patch when no camera is available.
 */

import { BOOL, COLOR, F, INT, MENU, top, type OperatorSpec } from './kit'

const constantTop = top({
  id: 'constant-top',
  label: 'Constant',
  category: 'generator',
  runtime: 'shader',
  description: 'Fills the frame with a single flat colour.',
  td: 'Constant TOP',
  keywords: ['solid', 'color', 'colour', 'fill', 'flat'],
  params: [COLOR('color', 'Colour', [0.05, 0.85, 0.4, 1]), F('gain', 'Gain', 1, 0, 4)],
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let c = p_color();
  return vec4f(c.rgb * p_gain(), c.a);
}
`,
})

const ramp = top({
  id: 'ramp',
  label: 'Ramp',
  category: 'generator',
  runtime: 'shader',
  description: 'Linear, radial, angular, or diamond gradient between two colours.',
  td: 'Ramp TOP',
  keywords: ['gradient', 'linear', 'radial', 'gradient map', 'gradation'],
  params: [
    MENU('type', 'Type', 0, ['Linear', 'Radial', 'Angular', 'Diamond', 'Box']),
    COLOR('colorA', 'Colour A', [0, 0, 0, 1]),
    COLOR('colorB', 'Colour B', [1, 1, 1, 1]),
    F('angle', 'Angle', 0, -1, 1, { help: 'Full turns. Only affects Linear and Angular.' }),
    F('offset', 'Offset', 0, -1, 1),
    F('scale', 'Scale', 1, 0.01, 8),
    F('exponent', 'Exponent', 1, 0.1, 8, { help: 'Bends the ramp toward one end.' }),
    F('centerX', 'Centre X', 0, -1, 1),
    F('centerY', 'Centre Y', 0, -1, 1),
    MENU('repeat', 'Repeat', 0, ['Clamp', 'Repeat', 'Mirror']),
  ],
  shader: /* wgsl */ `
fn ramp_repeat(t: f32, mode: i32) -> f32 {
  switch mode {
    case 1: { return fract(t); }
    case 2: { return 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0); }
    default: { return clamp(t, 0.0, 1.0); }
  }
}

fn shade(uv: vec2f) -> vec4f {
  let p = centered(uv) - vec2f(p_centerX(), p_centerY());
  let a = p_angle() * TAU;
  let dir = vec2f(cos(a), sin(a));

  var t: f32;
  switch p_typeI() {
    case 1: { t = length(p) * 0.5; }
    case 2: { t = (atan2(p.y, p.x) / TAU) + 0.5; }
    case 3: { t = (abs(p.x) + abs(p.y)) * 0.5; }
    case 4: { t = max(abs(p.x), abs(p.y)) * 0.5; }
    default: { t = dot(p, dir) * 0.5 + 0.5; }
  }

  t = ramp_repeat((t + p_offset()) * p_scale(), p_repeatI());
  t = pow(clamp(t, 0.0, 1.0), p_exponent());
  return mix(p_colorA(), p_colorB(), t);
}
`,
})

const noiseTop = top({
  id: 'noise-top',
  label: 'Noise',
  category: 'generator',
  runtime: 'shader',
  description: 'Animated value, simplex, fractal, or cellular noise field.',
  td: 'Noise TOP',
  keywords: ['perlin', 'simplex', 'fbm', 'worley', 'cellular', 'random', 'grain', 'clouds'],
  params: [
    MENU('type', 'Type', 2, ['Random', 'Value', 'Simplex', 'Fractal', 'Cellular', 'Ridged']),
    F('scale', 'Scale', 4, 0.1, 64, { log: true }),
    F('aspectLock', 'Aspect Lock', 1, 0, 1, { help: '1 keeps noise cells square on wide frames.' }),
    F('translateX', 'Translate X', 0, -8, 8),
    F('translateY', 'Translate Y', 0, -8, 8),
    F('speed', 'Speed', 0.15, -4, 4, { help: 'Scrolls the field over time.' }),
    INT('octaves', 'Octaves', 4, 1, 8, { page: 'Fractal' }),
    F('lacunarity', 'Lacunarity', 2, 1, 4, { page: 'Fractal' }),
    F('gain', 'Gain', 0.5, 0, 1, { page: 'Fractal' }),
    F('amplitude', 'Amplitude', 1, 0, 4, { page: 'Output' }),
    F('offset', 'Offset', 0.5, -1, 2, { page: 'Output' }),
    F('contrast', 'Contrast', 1, 0, 8, { page: 'Output' }),
    BOOL('monochrome', 'Monochrome', true, { page: 'Output' }),
    COLOR('tint', 'Tint', [1, 1, 1, 1], { page: 'Output' }),
  ],
  shader: /* wgsl */ `
fn noise_field(q: vec2f, kind: i32) -> f32 {
  switch kind {
    case 0: { return hash21(floor(q * 64.0)); }
    case 1: { return vnoise(q); }
    case 2: { return snoise(q) * 0.5 + 0.5; }
    case 3: { return fbm(q, p_octavesI(), p_lacunarity(), p_gain()) * 0.5 + 0.5; }
    case 4: { return worley(q); }
    // Ridged multifractal: folding the fbm around zero produces the sharp
    // creases that read as smoke or marble rather than soft clouds.
    case 5: { return 1.0 - abs(fbm(q, p_octavesI(), p_lacunarity(), p_gain())); }
    default: { return 0.5; }
  }
}

fn shade(uv: vec2f) -> vec4f {
  let stretch = mix(1.0, U.aspect, p_aspectLock());
  var q = (uv - 0.5) * vec2f(stretch, 1.0) * p_scale();
  q = q + vec2f(p_translateX(), p_translateY()) + vec2f(U.time * p_speed(), 0.0);

  let kind = p_typeI();
  let base = noise_field(q, kind);

  // Offsetting the sample position per channel is cheaper than three separate
  // noise evaluations at different seeds and gives a pleasant chromatic drift.
  let g = noise_field(q + vec2f(17.3, 4.1), kind);
  let b = noise_field(q + vec2f(-9.7, 23.6), kind);

  var rgb = select(vec3f(base, g, b), vec3f(base), p_monochromeB());
  rgb = (rgb - 0.5) * p_contrast() * p_amplitude() + p_offset();
  let t = p_tint();
  return vec4f(rgb * t.rgb, t.a);
}
`,
})

const circle = top({
  id: 'circle',
  label: 'Circle',
  category: 'generator',
  runtime: 'shader',
  description: 'Anti-aliased circle or ring, useful as a matte or a mask.',
  td: 'Circle TOP',
  keywords: ['ellipse', 'ring', 'dot', 'mask', 'matte', 'shape'],
  params: [
    F('radius', 'Radius', 0.5, 0, 2),
    F('softness', 'Softness', 0.01, 0, 1),
    F('thickness', 'Thickness', 0, 0, 1, { help: '0 draws a filled disc; above 0 draws a ring.' }),
    F('centerX', 'Centre X', 0, -2, 2),
    F('centerY', 'Centre Y', 0, -2, 2),
    F('stretchX', 'Stretch X', 1, 0.05, 4),
    F('stretchY', 'Stretch Y', 1, 0.05, 4),
    COLOR('fill', 'Fill', [1, 1, 1, 1]),
    COLOR('background', 'Background', [0, 0, 0, 0]),
  ],
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let p = (centered(uv) - vec2f(p_centerX(), p_centerY())) / vec2f(p_stretchX(), p_stretchY());
  let d = sdCircle(p, p_radius());

  // A ring is the filled disc minus a smaller disc, expressed as the distance
  // to the ring's centreline so both edges antialias identically.
  let ringed = abs(d) - p_thickness() * 0.5;
  let field = select(d, ringed, p_thickness() > 0.0);

  let mask = 1.0 - softStep(0.0, max(p_softness(), 1.0e-4), field);
  return mix(p_background(), p_fill(), mask);
}
`,
})

const rectangle = top({
  id: 'rectangle',
  label: 'Rectangle',
  category: 'generator',
  runtime: 'shader',
  description: 'Anti-aliased rounded rectangle or outline.',
  td: 'Rectangle TOP',
  keywords: ['box', 'square', 'bar', 'frame', 'mask', 'shape'],
  params: [
    F('sizeX', 'Size X', 0.6, 0, 3),
    F('sizeY', 'Size Y', 0.4, 0, 3),
    F('cornerRadius', 'Corner Radius', 0.05, 0, 1),
    F('softness', 'Softness', 0.01, 0, 1),
    F('thickness', 'Thickness', 0, 0, 1, { help: '0 fills the shape; above 0 draws an outline.' }),
    F('centerX', 'Centre X', 0, -2, 2),
    F('centerY', 'Centre Y', 0, -2, 2),
    F('rotate', 'Rotate', 0, -1, 1, { help: 'Full turns.' }),
    COLOR('fill', 'Fill', [1, 1, 1, 1]),
    COLOR('background', 'Background', [0, 0, 0, 0]),
  ],
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  var p = centered(uv) - vec2f(p_centerX(), p_centerY());
  p = rot2(-p_rotate() * TAU) * p;

  let half = vec2f(p_sizeX(), p_sizeY());
  // Clamp the corner radius to the shorter half-extent, otherwise a large
  // radius inverts the SDF and the shape turns inside out.
  let r = min(p_cornerRadius(), min(half.x, half.y));
  let d = sdBox(p, half, r);

  let outlined = abs(d) - p_thickness() * 0.5;
  let field = select(d, outlined, p_thickness() > 0.0);

  let mask = 1.0 - softStep(0.0, max(p_softness(), 1.0e-4), field);
  return mix(p_background(), p_fill(), mask);
}
`,
})

const checker = top({
  id: 'checker',
  label: 'Checker',
  category: 'generator',
  runtime: 'shader',
  description: 'Checkerboard or grid, handy as a calibration and alignment source.',
  td: 'Checker TOP',
  keywords: ['grid', 'chess', 'test pattern', 'calibration', 'tiles'],
  params: [
    MENU('mode', 'Mode', 0, ['Checker', 'Grid Lines', 'Bars']),
    F('cellsX', 'Cells X', 8, 1, 64),
    F('cellsY', 'Cells Y', 8, 1, 64),
    F('offsetX', 'Offset X', 0, -1, 1),
    F('offsetY', 'Offset Y', 0, -1, 1),
    F('softness', 'Softness', 0.002, 0, 0.5),
    F('lineWidth', 'Line Width', 0.05, 0, 0.5, { help: 'Only used by Grid Lines and Bars.' }),
    COLOR('colorA', 'Colour A', [0.05, 0.05, 0.06, 1]),
    COLOR('colorB', 'Colour B', [0.85, 0.85, 0.9, 1]),
  ],
  shader: /* wgsl */ `
fn shade(uv: vec2f) -> vec4f {
  let cells = vec2f(max(p_cellsX(), 0.001), max(p_cellsY(), 0.001));
  let q = uv * cells + vec2f(p_offsetX(), p_offsetY()) * cells;
  let f = fract(q);
  let s = max(p_softness(), 1.0e-4) * max(cells.x, cells.y) * 0.05 + 1.0e-4;

  var mask: f32;
  switch p_modeI() {
    case 1: {
      // Distance to the nearest cell border, in cell units.
      let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
      mask = 1.0 - smoothstep(p_lineWidth() - s, p_lineWidth() + s, edge);
    }
    case 2: {
      mask = 1.0 - smoothstep(p_lineWidth() - s, p_lineWidth() + s, min(f.x, 1.0 - f.x));
    }
    default: {
      let cell = floor(q);
      let parity = fract((cell.x + cell.y) * 0.5) * 2.0;
      mask = parity;
    }
  }

  return mix(p_colorA(), p_colorB(), clamp(mask, 0.0, 1.0));
}
`,
})

export const generatorOperators: OperatorSpec[] = [
  constantTop,
  ramp,
  noiseTop,
  circle,
  rectangle,
  checker,
]
