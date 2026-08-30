import { useEffect, useRef, useState } from 'react'
import { useGraphStore } from '../graph/store'
import type { EffectKind } from '../graph/types'
import { shader } from '../gpu/shader.wgsl'
const ids: Record<EffectKind, number> = { none: 0, vhs: 1, pixelate: 2, kaleidoscope: 3, chromatic: 4 }

export function WebGPUPreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const effectNode = useGraphStore((s) => s.nodes.find((n) => n.data.kind === 'effect' && n.data.enabled))
  const effectRef = useRef(effectNode); effectRef.current = effectNode
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
      const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] })
      const started = performance.now()
      function render() {
        if (stopped) return
        const ratio = Math.min(devicePixelRatio, 2), width = Math.max(1, Math.floor(targetCanvas.clientWidth * ratio)), height = Math.max(1, Math.floor(targetCanvas.clientHeight * ratio))
        if (targetCanvas.width !== width || targetCanvas.height !== height) { targetCanvas.width = width; targetCanvas.height = height }
        const node = effectRef.current, effect = (node?.data.effect as EffectKind | undefined) ?? 'none'
        device.queue.writeBuffer(buffer, 0, new Float32Array([width, height, (performance.now()-started)/1000, node?.data.intensity ?? 0, ids[effect], 0, 0, 0]))
        const encoder=device.createCommandEncoder(), pass=encoder.beginRenderPass({ colorAttachments:[{ view:context.getCurrentTexture().createView(), clearValue:{r:.01,g:.02,b:.02,a:1}, loadOp:'clear', storeOp:'store' }] })
        pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.draw(3); pass.end(); device.queue.submit([encoder.finish()]); frame=requestAnimationFrame(render)
      }
      render(); device.lost.then((info) => { if (!stopped) setError(`WebGPU device lost: ${info.message}`) })
    }
    start().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'WebGPU initialization failed.'))
    return () => { stopped=true; cancelAnimationFrame(frame) }
  }, [])
  return <div className="preview-wrap"><canvas ref={canvasRef} aria-label="Live WebGPU output" /><div className="preview-overlay"><span>WEBGPU</span><b>{effectNode?.data.effect ?? 'bypass'}</b></div>{error && <div className="gpu-error"><strong>GPU OFFLINE</strong><span>{error}</span></div>}</div>
}
