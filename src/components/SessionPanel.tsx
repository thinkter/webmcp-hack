/**
 * Session panel: audio input, MIDI, and the shareable links.
 *
 * The QR code is the whole point of the remote camera feature — a phone has to
 * be able to join without anybody typing an IP address — so it is generated
 * for whatever slot the patch's Remote Camera operators are listening on.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Camera,
  CameraOff,
  Copy,
  Mic,
  MicOff,
  Monitor,
  Music,
  Radio,
  Volume2,
  VolumeX,
  Wifi,
} from 'lucide-react'
import { audioEngine } from '../audio/engine'
import { midiEngine } from '../audio/midi'
import { getOperator } from '../engine/ops'
import { isOriginPhoneReachable, joinUrl, outputUrl, qrDataUrl } from '../remote/links'
import { resolveParams, usePatchStore } from '../graph/store'
import { useAudioState, useEngineStatus, useMidiState, useRemoteState } from '../hooks/useEngineStatus'
import { useSession } from '../collab/useSession'
import { mediaHub } from '../remote/hub'
import { RoomJoin } from './RoomJoin'

export function SessionPanel() {
  const nodes = usePatchStore((state) => state.nodes)
  const status = useEngineStatus()
  const audio = useAudioState()
  const midi = useMidiState()
  const remote = useRemoteState()
  const session = useSession()

  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  useEffect(() => {
    void audioEngine.listDevices().then(setDevices)
  }, [audio.state])

  const remoteSlots = useMemo(() => {
    const slots = new Set<string>()
    for (const node of nodes) {
      if (node.data.op !== 'remote-in') continue
      const slot = resolveParams(node).slot
      if (typeof slot === 'string' && slot) slots.add(slot)
    }
    return [...slots]
  }, [nodes])

  const outputSlots = useMemo(() => {
    const slots = new Set<string>()
    for (const node of nodes) {
      if (getOperator(node.data.op)?.id !== 'remote-out') continue
      const slot = resolveParams(node).slot
      if (typeof slot === 'string' && slot) slots.add(slot)
    }
    return [...slots]
  }, [nodes])

  return (
    <section className="session">
      <header className="panel-head">
        <div>
          <span>SESSION</span>
          <strong>{connectedLabel(session.status, session.room, session.peers)}</strong>
        </div>
        <span className={`chip status-${session.status}`}>
          <Wifi size={11} />
          {session.status}
          {session.peers > 1 ? ` · ${session.peers}` : ''}
        </span>
      </header>

      <div className="session-body">
        {session.error ? (
          <p className="notice is-warning" style={{ margin: 0 }}>
            <AlertTriangle size={12} />
            <span>{session.error}</span>
          </p>
        ) : null}
        <RoomJoin />
        {/* -------------------------------------------------------- audio -- */}
        <AudioSection audio={audio} devices={devices} remoteStreams={remote.streams} />

        {/* --------------------------------------------------------- midi -- */}
        <div className="session-block">
          <h4>MIDI</h4>
          <div className="session-row">
            <button
              type="button"
              disabled={midi.state === 'unsupported'}
              className={midi.state === 'running' ? 'is-active' : ''}
              onClick={() => {
                if (midi.state === 'running') midiEngine.stop()
                else void midiEngine.start()
              }}
            >
              {midi.state === 'unsupported'
                ? 'Not supported'
                : midi.state === 'running'
                  ? `${midi.inputs.length} device${midi.inputs.length === 1 ? '' : 's'}`
                  : 'Enable'}
            </button>
          </div>
          {midi.error ? <p className="muted small">{midi.error}</p> : null}
        </div>

        {/* ------------------------------------------------------- remote -- */}
        <div className="session-block">
          <h4>
            <Radio size={12} /> Remote cameras
          </h4>

          {!isOriginPhoneReachable() ? (
            <p className="notice is-warning">
              <AlertTriangle size={12} />
              <span>
                This page is open on <code>localhost</code>, so a phone cannot reach the QR link.
                Reopen the editor at your machine's LAN address.
              </span>
            </p>
          ) : null}

          {remoteSlots.length === 0 ? (
            <p className="muted small">
              Add a Remote Camera operator to generate a join link for a phone or share your screen/camera.
            </p>
          ) : (
            remoteSlots.map((slot) => (
              <RemoteSlotShare
                key={slot}
                slot={slot}
                url={joinUrl(session.room, slot)}
                remoteStream={remote.streams.get(slot)}
              />
            ))
          )}
        </div>

        {/* ------------------------------------------------------ outputs -- */}
        {outputSlots.length ? (
          <div className="session-block">
            <h4>Remote outputs</h4>
            {outputSlots.map((slot) => (
              <ShareTarget key={slot} label={slot} url={outputUrl(session.room, slot)} />
            ))}
          </div>
        ) : null}

        {/* ---------------------------------------------------------- gpu -- */}
        <div className="session-block session-gpu">
          <h4>Engine</h4>
          <dl>
            <div>
              <dt>Adapter</dt>
              <dd>{status.adapter ?? '—'}</dd>
            </div>
            <div>
              <dt>Frame</dt>
              <dd>
                {status.fps} fps · {status.frameMs} ms
              </dd>
            </div>
            <div>
              <dt>Textures</dt>
              <dd>
                {status.textures.live} live · {status.textures.pooled} pooled
              </dd>
            </div>
            <div>
              <dt>Pipelines</dt>
              <dd>{status.pipelines}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  )
}

function connectedLabel(status: string, room: string, peers: number): string {
  if (status === 'online') return peers > 1 ? `${room} · ${peers} online` : `${room} · live`
  if (status === 'connecting') return `${room} · connecting`
  return room
}

function AudioSection({
  audio,
  devices,
  remoteStreams,
}: {
  audio: ReturnType<typeof useAudioState>
  devices: Array<{ deviceId: string; label: string }>
  remoteStreams: Map<string, import('../remote/hub').RemoteStream>
}) {
  const [selectedSource, setSelectedSource] = useState<string>('mic')
  const [hearAudio, setHearAudio] = useState(false)
  const [volume, setVolume] = useState(0.8)
  const audioElemRef = useRef<HTMLAudioElement | null>(null)

  // Streams that have at least one audio track
  const audioStreams = useMemo(() => {
    const list: Array<{ slot: string; label: string; stream: MediaStream; isLocal?: boolean }> = []
    for (const [slot, remoteStream] of remoteStreams.entries()) {
      if (remoteStream.stream.getAudioTracks().length > 0) {
        list.push({
          slot,
          label: remoteStream.label || slot,
          stream: remoteStream.stream,
          isLocal: remoteStream.isLocal,
        })
      }
    }
    return list
  }, [remoteStreams])

  // Setup speaker output audio element
  useEffect(() => {
    if (typeof Audio === 'undefined') return
    const el = new Audio()
    el.autoplay = true
    audioElemRef.current = el
    return () => {
      el.srcObject = null
      el.pause()
      audioElemRef.current = null
    }
  }, [])

  // Update hearAudio output when source or hearAudio toggle changes
  useEffect(() => {
    const el = audioElemRef.current
    if (!el) return
    if (!hearAudio) {
      el.srcObject = null
      el.pause()
      return
    }

    if (selectedSource.startsWith('stream:')) {
      const slot = selectedSource.slice(7)
      const target = remoteStreams.get(slot)
      if (target && !target.isLocal) {
        el.srcObject = target.stream
        el.volume = volume
        void el.play().catch(() => undefined)
      } else {
        el.srcObject = null
        el.pause()
      }
    } else {
      // Local mic listening through speakers is muted by default to prevent feedback
      el.srcObject = null
      el.pause()
    }
  }, [hearAudio, selectedSource, remoteStreams, volume])

  const handleSourceChange = (val: string) => {
    setSelectedSource(val)
    if (val === 'mic') {
      void audioEngine.start()
    } else if (val.startsWith('stream:')) {
      const slot = val.slice(7)
      const target = remoteStreams.get(slot)
      if (target) {
        void audioEngine.attachStream(target.stream)
      }
    }
  }

  return (
    <div className="session-block">
      <h4>
        <Music size={12} /> Audio
      </h4>
      <div className="session-row">
        <button
          type="button"
          className={audio.state === 'running' ? 'is-active' : ''}
          onClick={() => {
            if (audio.state === 'running') {
              audioEngine.stop()
            } else {
              handleSourceChange(selectedSource)
            }
          }}
        >
          {audio.state === 'running' ? <MicOff size={13} /> : <Mic size={13} />}
          {audio.state === 'running' ? 'Stop' : 'Listen'}
        </button>

        <select
          value={selectedSource}
          onChange={(event) => handleSourceChange(event.target.value)}
        >
          <optgroup label="Local Input">
            <option value="mic">Microphone</option>
          </optgroup>
          {audioStreams.length > 0 ? (
            <optgroup label="Shared Streams">
              {audioStreams.map((st) => (
                <option key={st.slot} value={`stream:${st.slot}`}>
                  {st.slot} ({st.label}){st.isLocal ? ' [You]' : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>

      {selectedSource === 'mic' && devices.length > 0 ? (
        <div className="session-row" style={{ marginTop: 'var(--sp-2)' }}>
          <select
            value={audio.deviceId ?? ''}
            onChange={(event) => void audioEngine.start(event.target.value || undefined)}
          >
            <option value="">Default input device</option>
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {/* Audio monitor for incoming stream */}
      {selectedSource.startsWith('stream:') && (
        <div className="session-row" style={{ marginTop: 'var(--sp-2)', alignItems: 'center' }}>
          <button
            type="button"
            className={hearAudio ? 'is-active' : ''}
            onClick={() => setHearAudio(!hearAudio)}
            title="Hear collaborator audio through your speakers or headphones"
          >
            {hearAudio ? <Volume2 size={13} /> : <VolumeX size={13} />}
            {hearAudio ? 'Mute' : 'Hear Audio'}
          </button>
          {hearAudio && (
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setVolume(v)
                if (audioElemRef.current) audioElemRef.current.volume = v
              }}
              style={{ width: 80 }}
            />
          )}
        </div>
      )}

      {audio.error ? (
        <p className="notice is-warning">
          <AlertTriangle size={12} />
          {audio.error}
        </p>
      ) : null}

      <div className="meters">
        <Meter label="level" value={audio.level} />
        <Meter label="beat" value={audio.beat} accent />
        <span className="meter-bpm">{audio.bpm ? `${audio.bpm} bpm` : '— bpm'}</span>
      </div>
      <p className="muted small">
        Wire an Audio Band operator to any parameter to make the patch react.
      </p>
    </div>
  )
}

function RemoteSlotShare({
  slot,
  url,
  remoteStream,
}: {
  slot: string
  url: string
  remoteStream?: import('../remote/hub').RemoteStream
}) {
  const [publishing, setPublishing] = useState<'camera' | 'screen' | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const stopSharing = () => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    mediaHub.unpublishSlot(slot)
    setPublishing(null)
  }

  const shareWebcam = async () => {
    if (publishing) {
      stopSharing()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      streamRef.current = stream
      setPublishing('camera')
      mediaHub.publishStream(slot, 'Webcam', stream)
      const track = stream.getVideoTracks()[0]
      track?.addEventListener('ended', stopSharing)
    } catch (err) {
      console.error('[share] camera access failed:', err)
    }
  }

  const shareScreen = async () => {
    if (publishing) {
      stopSharing()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      })
      streamRef.current = stream
      setPublishing('screen')
      mediaHub.publishStream(slot, 'Screen', stream)
      const track = stream.getVideoTracks()[0]
      track?.addEventListener('ended', stopSharing)
    } catch (err) {
      console.error('[share] screen access failed:', err)
    }
  }

  const isConnected = !!remoteStream
  const isLocalPub = remoteStream?.isLocal

  return (
    <div className={`share ${isConnected ? 'is-connected' : ''}`}>
      <ShareQr url={url} label={slot} />
      <div>
        <strong>
          {slot}
          {isConnected ? (
            isLocalPub ? (
              <span className="share-local">You are sharing</span>
            ) : (
              <span className="share-live">live</span>
            )
          ) : null}
        </strong>
        <code>{url.replace(/^https?:\/\//, '')}</code>

        <div className="share-pub-actions" style={{ marginTop: 'var(--sp-1)' }}>
          <button
            type="button"
            className={publishing === 'camera' ? 'is-active' : ''}
            onClick={() => void shareWebcam()}
          >
            {publishing === 'camera' ? <CameraOff size={11} /> : <Camera size={11} />}
            {publishing === 'camera' ? 'Stop Cam' : 'Webcam'}
          </button>
          <button
            type="button"
            className={publishing === 'screen' ? 'is-active' : ''}
            onClick={() => void shareScreen()}
          >
            <Monitor size={11} />
            {publishing === 'screen' ? 'Stop Screen' : 'Screen'}
          </button>
        </div>

        <div className="share-actions">
          <button type="button" onClick={() => void navigator.clipboard?.writeText(url)}>
            <Copy size={11} />
            Copy Link
          </button>
          <a href={url} target="_blank" rel="noreferrer">
            Phone Join
          </a>
        </div>
      </div>
    </div>
  )
}

function ShareQr({ url, label }: { url: string; label: string }) {
  const [qr, setQr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void qrDataUrl(url, 168).then((data) => {
      if (!cancelled) setQr(data)
    })
    return () => {
      cancelled = true
    }
  }, [url])

  return qr ? (
    <img src={qr} alt={`QR code for ${label}`} width={84} height={84} />
  ) : (
    <div className="share-qr-placeholder" />
  )
}

function ShareTarget({
  label,
  url,
  connected,
}: {
  label: string
  url: string
  connected?: boolean
}) {
  return (
    <div className={`share ${connected ? 'is-connected' : ''}`}>
      <ShareQr url={url} label={label} />
      <div>
        <strong>
          {label}
          {connected ? <span className="share-live">live</span> : null}
        </strong>
        <code>{url.replace(/^https?:\/\//, '')}</code>
        <div className="share-actions">
          <button type="button" onClick={() => void navigator.clipboard?.writeText(url)}>
            <Copy size={11} />
            Copy
          </button>
          <a href={url} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      </div>
    </div>
  )
}

function Meter({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`meter ${accent ? 'is-accent' : ''}`}>
      <span>{label}</span>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
    </div>
  )
}

