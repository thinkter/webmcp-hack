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

`inspect_graph`, `list_operators`, `create_node`, `connect_nodes`, `set_parameter`, `delete_node`, `list_sources`, and `list_outputs` all operate on the same graph store as the UI.

## Operator graph

The editor distinguishes texture-carrying TOP ports from numeric CHOP ports. Its operator browser currently includes 38 nodes across sources, generators, effects, composites, controls, audio, and outputs. Invalid type connections, occupied inputs, and self-connections are rejected.

Implemented runtime paths currently include the procedural Noise TOP, ordered chains of up to four VHS, chromatic aberration, pixelate, and kaleidoscope GPU effects, Preview output, and LFO/constant modulation of effect intensity. The remaining catalog entries establish the graph and UI contracts but still need their corresponding media or GPU runtime implementations.

Canvas shortcuts:

- `Tab`: open the operator browser
- `Delete` / `Backspace`: delete the selected node
- `Ctrl/Cmd + D`: duplicate the selected node
- `Shift`: multi-select

The implementation feature-detects WebMCP, so the editor and WebGPU renderer still work in browsers that do not expose `document.modelContext`.

## License

[MIT](LICENSE)
