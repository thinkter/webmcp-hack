A free, open-source, browser-based live visual programming tool — like TouchDesigner meets Figma. Users can combine local or remote video/audio sources, process them with WebGPU-powered visual nodes, collaborate on the same graph in real time, and route outputs to displays or streams anywhere. WebMCP gives agents semantic control over the whole production setup, from editing the graph to managing sources, outputs, and live changes.
Build it in this order, optimizing for the hackathon rather than for completeness:

1. **Node graph + WebGPU rendering first**

   * Basic canvas
   * Create/connect/delete nodes
   * `Camera → Effect → Output`
   * 5–6 GPU effects
   * Custom WGSL shader node
     This proves the core product exists.

2. **WebMCP immediately after**
   Do not leave this until the end. Expose:

   ```text
   inspect_graph()
   create_node()
   connect_nodes()
   set_parameter()
   delete_node()
   list_sources()
   list_outputs()
   ```

   Then make the killer flow work:

   > “Add a VHS effect to Camera 1 and make its intensity react to the bass.”

   If this works well, you already satisfy the most important judging criterion: **WebMCP leverage**.

3. **Remote camera input**

   * Generate share link / QR
   * Open on phone
   * Allow camera
   * mediasoup/WebRTC producer
   * Camera appears as a node in the editor
     This is your first major “holy shit” demo moment.

4. **Audio-reactive nodes**
   Add:

   ```text
   Microphone
   FFT
   Bass
   Mid
   Treble
   LFO
   ```

   Then allow values to control shader parameters. This makes it actually relevant to concerts/VJing.

5. **Multiplayer editing**

   * Login
   * Shared project
   * Yjs/CRDT
   * Two people editing the same graph
   * Presence/cursors
   * Track who changed what
     Don't overbuild permissions initially.

6. **Remote output**
   Generate another link:

   ```text
   /output/abc123
   ```

   Open it on another laptop/projector and have it render the shared graph.

   Now you can show:

   ```text
   Phone in location A
          ↓
      live camera
          ↓
   collaborative graph
          ↓
      GPU effects
          ↓
   laptop/projector B
   ```

7. **Give WebMCP system-wide awareness**
   Once the above exists, add the impressive semantic tools:

   ```text
   get_recent_changes()
   get_media_topology()
   inspect_output()
   inspect_source()
   trace_dependencies()
   get_system_health()
   route_source_to_output()
   ```

   This is where the project stops being “AI edits nodes” and becomes **agent-operated live production infrastructure**.

8. **Agent provenance + undo**
   Every operation records:

   ```text
   who
   what
   when
   before
   after
   human / agent
   ```

   Then demo:

   > “Undo everything ChatGPT changed in the last two minutes.”

   Very strong WebMCP/human-agent collaboration story.

9. **Only then add WebTransport**
   Use it where it genuinely makes sense:

   * reliable streams → graph edits/state
   * datagrams → cursors, meters, transient parameter updates

   Do not let WebTransport implementation eat hackathon time if WebRTC + ordinary WebSockets can get your demo working first.

10. **Polish the 3-minute demo instead of adding more features**
    Your final demo should basically be:

```text
1. Open editor.
2. Phone scans QR → remote camera appears.
3. Second person joins and edits graph.
4. Remote projector/output connects.
5. Ask agent:
   "Make camera 2 glitch on the bass and send
    the clean version to stream output."
6. WebMCP inspects system.
7. Agent creates/rewires nodes.
8. Changes appear live for everyone.
9. Show provenance:
   "ChatGPT changed these 4 things."
```

### Priority for the hackathon

If you start running out of time, protect these in this order:

```text
MUST HAVE
1. WebGPU node editor
2. Strong WebMCP interaction
3. Remote WebRTC camera
4. Remote output
5. Multiplayer

VERY GOOD
6. Audio reactive graph
7. Provenance/history
8. Agent topology/health inspection

NICE TO HAVE
9. WebTransport
10. sophisticated permissions
11. distributed graph execution
12. automatic compute placement
13. dozens of nodes
```

The biggest mistake would be spending two days building a perfect TouchDesigner clone and then bolting three WebMCP tools onto it.

For **this hackathon**, build the smallest visual engine necessary to demonstrate:

> **remote media + collaborative visual graph + distributed outputs + an agent that actually understands and operates the whole system.**

That should be the core.

