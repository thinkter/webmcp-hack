/**
 * Editable lobby control — type a room code, mint a new one, join or switch
 * without disconnecting first.
 */

import { useEffect, useState } from 'react'
import { Copy, Dices, Link2 } from 'lucide-react'
import { inviteUrl } from '../collab/session'
import { useSession } from '../collab/useSession'

const sanitize = (value: string): string =>
  value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)

export function RoomJoin({ compact = false }: { compact?: boolean }) {
  const session = useSession()
  const [draft, setDraft] = useState(session.room)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setDraft(session.room)
  }, [session.room])

  const connected = session.status === 'online' || session.status === 'connecting'
  const target = sanitize(draft)
  const dirty = target.length > 0 && target !== session.room

  const commit = (code = target) => {
    const next = sanitize(code)
    if (next.length === 0) {
      session.join()
      return
    }
    session.join(next)
  }

  const onDraft = (value: string) => {
    const next = sanitize(value)
    setDraft(next)
    if (!connected) session.setRoom(next)
  }

  const copyInvite = async () => {
    await session.copyInviteLink()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const actionLabel = connected
    ? dirty
      ? session.status === 'connecting'
        ? 'Switching…'
        : 'Switch'
      : session.status === 'connecting'
        ? 'Connecting…'
        : 'Disconnect'
    : 'Join'

  const onAction = () => {
    if (connected && !dirty) {
      session.leave()
      return
    }
    commit()
  }

  const field = (
    <input
      className={compact ? 'toolbar-room' : 'room-code-input'}
      value={draft}
      spellCheck={false}
      autoCapitalize="characters"
      autoCorrect="off"
      autoComplete="off"
      maxLength={24}
      aria-label="Lobby code"
      placeholder="ROOM CODE"
      onChange={(event) => onDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
    />
  )

  if (compact) {
    return (
      <div className="toolbar-group room-join-compact">
        {field}
        <button
          type="button"
          title="New lobby code"
          onClick={() => {
            const code = session.mintRoom()
            setDraft(code)
          }}
        >
          <Dices size={14} />
        </button>
        <button
          type="button"
          title={copied ? 'Invite copied' : 'Copy invite link'}
          onClick={() => void copyInvite()}
        >
          {copied ? <Link2 size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          className={connected && !dirty ? 'is-active' : 'primary'}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      </div>
    )
  }

  const invite = inviteUrl()

  return (
    <div className="session-block room-join">
      <h4>Lobby</h4>
      <p className="muted small">
        Type a code to join someone else, or mint a new one. Switching rooms does not require disconnecting first.
      </p>
      <div className="session-row room-join-row">
        {field}
        <button
          type="button"
          title="Mint a new lobby"
          onClick={() => {
            const code = session.mintRoom()
            setDraft(code)
          }}
        >
          <Dices size={13} />
          New
        </button>
      </div>
      <div className="session-row">
        <button type="button" className={connected && !dirty ? 'is-active' : ''} onClick={onAction}>
          {actionLabel}
          {dirty ? ` ${target}` : ''}
        </button>
        <button type="button" onClick={() => void copyInvite()}>
          <Copy size={13} />
          {copied ? 'Copied' : 'Copy invite'}
        </button>
      </div>
      <code className="room-invite">{invite.replace(/^https?:\/\//, '')}</code>
      {session.peers > 1 ? (
        <p className="muted small">
          {session.peers} people in {session.room}
        </p>
      ) : null}
    </div>
  )
}
