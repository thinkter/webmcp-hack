export const shader = /* wgsl */ `
struct Uniforms {
  resolution: vec2f,
  time: f32,
  intensity: f32,
  effect: f32,
  _padding0: f32,
  _padding1: f32,
  _padding2: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> Out {
  var p = array<vec2f, 3>(vec2f(-1.,-1.), vec2f(3.,-1.), vec2f(-1.,3.));
  var o: Out; o.position = vec4f(p[i],0.,1.); o.uv = o.position.xy * vec2f(.5,-.5) + .5; return o;
}
fn signal(uv: vec2f) -> vec3f {
  let p = (uv-.5)*vec2f(u.resolution.x/u.resolution.y,1.);
  let r = length(p); let a = atan2(p.y,p.x);
  let bands = sin(r*24.-u.time*2.4+sin(a*5.+u.time));
  let grid = sin((p.x+p.y)*13.+u.time)*cos((p.x-p.y)*11.-u.time*.7);
  let glow = .08/max(abs(r-.28-bands*.025),.015);
  return vec3f(.06+glow*.2,.12+glow*.72+grid*.04,.16+glow*.35);
}
@fragment fn fragmentMain(i: Out) -> @location(0) vec4f {
  var uv=i.uv; let kind=i32(u.effect);
  if kind==1 { let tear=step(.94,fract(sin(floor(uv.y*100.)+floor(u.time*8.))*43758.5453)); uv.x+=tear*sin(u.time*21.)*.06*u.intensity; }
  if kind==2 { let size=mix(180.,20.,u.intensity); uv=floor(uv*size)/size; }
  if kind==3 { let p=uv-.5; let a=abs(fract(atan2(p.y,p.x)/1.0472)-.5)*2.0944; uv=vec2f(cos(a),sin(a))*length(p)+.5; }
  var color=signal(uv);
  if kind==4 { let d=.012*u.intensity; color=vec3f(signal(uv+vec2f(d,0.)).r,color.g,signal(uv-vec2f(d,0.)).b); }
  if kind==1 { color*=.78+.22*sin(uv.y*u.resolution.y*1.5); color+=vec3f(.08,.01,.06)*sin(uv.y*280.+u.time*5.)*u.intensity; }
  return vec4f(pow(max(color,vec3f(0.)),vec3f(.86)),1.);
}`
