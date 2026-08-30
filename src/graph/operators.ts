import type { EffectKind, OperatorDefinition } from './types'

const top = (id:string,label:string,category:OperatorDefinition['category'],effect?:EffectKind,inputs=1):OperatorDefinition => ({id,label,family:'TOP',category,description:`${label} texture operator`,inputs:Array.from({length:inputs},(_,i)=>({id:`in-${i}`,label:inputs>1?`Input ${i+1}`:'Texture',type:'texture'})),outputs:[{id:'out',label:'Texture',type:'texture'}],defaults:{enabled:true,bypass:false,intensity:.5,...(effect?{effect}:{})}})
const chop = (id:string,label:string,category:OperatorDefinition['category'],inputs=0):OperatorDefinition => ({id,label,family:'CHOP',category,description:`${label} realtime control signal`,inputs:Array.from({length:inputs},(_,i)=>({id:`in-${i}`,label:`Value ${i+1}`,type:'number'})),outputs:[{id:'out',label:'Value',type:'number'}],defaults:{enabled:true,bypass:false,value:.5,speed:1,amplitude:1}})

export const operators:OperatorDefinition[]=[
  top('camera','Camera','source',undefined,0),top('remote-camera','Remote Camera','source',undefined,0),top('screen','Screen Capture','source',undefined,0),top('video','Video File','source',undefined,0),top('image','Image','source',undefined,0),top('color','Solid Color','generator',undefined,0),top('noise','Noise','generator',undefined,0),top('gradient','Gradient','generator',undefined,0),top('text','Text','generator',undefined,0),
  top('transform','Transform','effect','none'),top('blur','Blur','effect','none'),top('levels','Levels','effect','none'),top('color-grade','Color Grade','effect','chromatic'),top('pixelate','Pixelate','effect','pixelate'),top('displace','Displace','effect','vhs',2),top('kaleidoscope','Kaleidoscope','effect','kaleidoscope'),top('chromatic','Chromatic Aberration','effect','chromatic'),top('glitch','Glitch / VHS','effect','vhs'),top('feedback','Feedback','effect','vhs'),top('custom-wgsl','Custom WGSL','effect','none'),
  top('blend','Blend','composite','none',2),top('mask','Mask','composite','none',2),top('switch','Switch','composite','none',2),
  chop('constant','Constant','control'),chop('lfo','LFO','control'),chop('control-noise','Noise Signal','control'),chop('math','Math','control',2),chop('map-range','Map Range','control',1),chop('smooth','Smooth / Lag','control',1),chop('timer','Timer','control'),
  chop('microphone','Microphone','audio'),chop('fft','FFT','audio',1),chop('bass','Bass Energy','audio',1),chop('mid','Mid Energy','audio',1),chop('treble','Treble Energy','audio',1),chop('beat','Beat Detector','audio',1),
  {...top('preview','Preview','output',undefined,1),outputs:[]},{...top('remote-output','Remote Output','output',undefined,1),outputs:[]},
]
export const operatorMap=new Map(operators.map((operator)=>[operator.id,operator]))
export const categories=[
  ['source','Sources'],['generator','Generators'],['effect','Effects'],['composite','Composite'],['control','Control'],['audio','Audio'],['output','Outputs'],
] as const
