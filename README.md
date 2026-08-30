# WebMCP Hack

An open-source browser visual-programming experiment combining a node graph, a real WebGPU/WGSL rendering pipeline, and semantic WebMCP tools that let browser agents inspect and operate the graph.

The product name is intentionally provisional.

## Development

```bash
npm install
npm run dev
```

WebGPU requires a compatible browser. WebMCP currently requires ChatGPT's in-app browser or a compatible Chrome build with WebMCP enabled.

## Current vertical slice

- Draggable, connectable source/effect/output graph
- Real WebGPU render pipeline with WGSL fragment effects
- VHS, chromatic aberration, pixelation, and kaleidoscope modes
- Live node inspector driving GPU uniforms
- Seven imperative WebMCP tools registered through `document.modelContext`

### WebMCP tools

`inspect_graph`, `create_node`, `connect_nodes`, `set_parameter`, `delete_node`, `list_sources`, and `list_outputs` all operate on the same graph store as the UI.

The implementation feature-detects WebMCP, so the editor and WebGPU renderer still work in browsers that do not expose `document.modelContext`.

## License

[MIT](LICENSE)
