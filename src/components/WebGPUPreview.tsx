import { useEffect, useMemo, useRef, useState } from 'react'
import { buildExecutionPlan } from '../graph/execution'
import { useGraphStore } from '../graph/store'
import type { EffectKind } from '../graph/types'
import { shader } from '../gpu/shader.wgsl'
const ids: Record<EffectKind, number> = { none: 0, vhs: 1, pixelate: 2, kaleidoscope: 3, chromatic: 4 }
const sourceIds:Record<string,number>={noise:1,color:2,gradient:3}

export function WebGPUPreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodes=useGraphStore(state=>state.nodes),edges=useGraphStore(state=>state.edges)
  const plan=useMemo(()=>buildExecutionPlan(nodes,edges),[nodes,edges])
  const planRef=useRef(plan);planRef.current=plan
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const targetCanvas: HTMLCanvasElement = canvas
    let frame = 0; let stopped = false
    async function start() {
      if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current WebGPU-capable browser.')
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) throw new Error('No WebGPU adapter was found.')
      const device = await adapter.requestDevice()
      const candidate = targetCanvas.getContext('webgpu'); if (!candidate) throw new Error('Could not create a WebGPU canvas context.')
      const context: GPUCanvasContext = candidate
      const format = navigator.gpu.getPreferredCanvasFormat(); context.configure({ device, format, alphaMode: 'opaque' })
      const module = device.createShaderModule({ code: shader })
      const compilation = await module.getCompilationInfo()
      const shaderErrors = compilation.messages.filter((message) => message.type === 'error')
      if (shaderErrors.length) throw new Error(`WGSL compilation failed: ${shaderErrors.map((message) => message.message).join('; ')}`)
      const pipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vertexMain' }, fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] } })
      const buffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] })
      let timeline=0,lastTick=performance.now(),lastDraw=0
      function render(now=performance.now()) {
        if (stopped) return
        frame=requestAnimationFrame(render)
        const runtime=useGraphStore.getState(),delta=(now-lastTick)/1000;lastTick=now
        if(runtime.playing)timeline+=delta
        if(now-lastDraw<1000/runtime.fps)return
        lastDraw=now
        const ratio = Math.min(devicePixelRatio, 2), width = Math.max(1, Math.floor(targetCanvas.clientWidth * ratio)), height = Math.max(1, Math.floor(targetCanvas.clientHeight * ratio))
        if (targetCanvas.width !== width || targetCanvas.height !== height) { targetCanvas.width = width; targetCanvas.height = height }
        const time=timeline,state=runtime,currentPlan=planRef.current
        const stages=currentPlan.status==='ready'?currentPlan.stages.slice(0,4):[]
        const effectValues=[0,0,0,0],amountValues=[0,0,0,0]
        stages.forEach((node,index)=>{effectValues[index]=ids[(node.data.effect as EffectKind|undefined)??'none'];const edge=state.edges.find(candidate=>candidate.target===node.id&&candidate.targetHandle==='param:intensity'),controller=state.nodes.find(candidate=>candidate.id===edge?.source);const value=controller?.data.operatorId==='lfo'?(Math.sin(time*Number(controller.data.speed??1)*Math.PI*2)*.5+.5)*Number(controller.data.amplitude??1):Number(controller?.data.value??node.data.intensity??0);amountValues[index]=Math.min(1,Math.max(0,value))})
        const sourceId=currentPlan.status==='ready'?sourceIds[String(currentPlan.source?.data.operatorId)]??0:0
        device.queue.writeBuffer(buffer, 0, new Float32Array([width,height,time,stages.length,...effectValues,...amountValues,sourceId,0,0,0]))
        const encoder=device.createCommandEncoder(), pass=encoder.beginRenderPass({ colorAttachments:[{ view:context.getCurrentTexture().createView(), clearValue:{r:.01,g:.02,b:.02,a:1}, loadOp:'clear', storeOp:'store' }] })
        pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.draw(3); pass.end(); device.queue.submit([encoder.finish()])
      }
      render(); device.lost.then((info) => { if (!stopped) setError(`WebGPU device lost: ${info.message}`) })
    }
    start().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'WebGPU initialization failed.'))
    return () => { stopped=true; cancelAnimationFrame(frame) }
  }, [])
  return <div className="preview-wrap"><canvas ref={canvasRef} aria-label="Live WebGPU output" /><div className="preview-overlay"><span>WEBGPU</span><b>{plan.status==='ready'?`${plan.source?.data.label}${plan.stages.length?` + ${plan.stages.length} FX`:''}`:plan.status.toUpperCase()}</b></div>{plan.status!=='ready'&&!error&&<div className="no-signal"><strong>NO SIGNAL</strong><span>{plan.message}</span></div>}{error && <div className="gpu-error"><strong>GPU OFFLINE</strong><span>{error}</span></div>}</div>
}
