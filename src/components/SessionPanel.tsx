/**
 * Session panel: audio input, MIDI, and the shareable links.
 *
 * The QR code is the whole point of the remote camera feature — a phone has to
 * be able to join without anybody typing an IP address — so it is generated
 * for whatever slot the patch's Remote Camera operators are listening on.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, Mic, MicOff, Music, Radio, Wifi } from 'lucide-react'
import { audioEngine } from '../audio/engine'
import { midiEngine } from '../audio/midi'
import { getOperator } from '../engine/ops'
import { isOriginPhoneReachable, joinUrl, outputUrl, qrDataUrl } from '../remote/links'
import { resolveParams, usePatchStore } from '../graph/store'
import { useAudioState, useEngineStatus, useMidiState, useRemoteState } from '../hooks/useEngineStatus'
import { useSession } from '../collab/useSession'
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
        <div className="session-block">
          <h4>
            <Music size={12} /> Audio
          </h4>
          <div className="session-row">
            <button
              type="button"
              className={audio.state === 'running' ? 'is-active' : ''}
              onClick={() => {
                if (audio.state === 'running') audioEngine.stop()
                else void audioEngine.start()
              }}
            >
              {audio.state === 'running' ? <MicOff size={13} /> : <Mic size={13} />}
              {audio.state === 'running' ? 'Stop' : 'Listen'}
            </button>
            <select
              value={audio.deviceId ?? ''}
              onChange={(event) => void audioEngine.start(event.target.value || undefined)}
            >
              <option value="">Default input</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label}
                </option>
              ))}
            </select>
          </div>

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
            Add an Audio Band operator and wire it into any parameter to make the patch react.
          </p>
        </div>

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
              Add a Remote Camera operator to generate a join link for a phone.
            </p>
          ) : (
            remoteSlots.map((slot) => (
              <ShareTarget
                key={slot}
                label={slot}
                url={joinUrl(session.room, slot)}
                connected={remote.streams.has(slot)}
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

function ShareTarget({
  label,
  url,
  connected,
}: {
  label: string
  url: string
  connected?: boolean
}) {
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

  return (
    <div className={`share ${connected ? 'is-connected' : ''}`}>
      {qr ? <img src={qr} alt={`QR code for ${label}`} width={84} height={84} /> : <div className="share-qr-placeholder" />}
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

