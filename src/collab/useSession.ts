/**
 * React binding for the collaboration session.
 *
 * All of the state lives in `session.ts` as a module-level singleton, so this
 * hook is a thin `useSyncExternalStore` adapter: several components can call it
 * at once, and none of them owns the connection. Mounting does not connect and
 * unmounting does not disconnect — joining and leaving are explicit user
 * actions, and a component being re-rendered or remounted (React StrictMode
 * mounts twice) must never open or close a socket as a side effect.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { parseRoomParams } from '../remote/links'
import type { Presence } from './presence'
import {
  copyInviteLink,
  getSessionState,
  joinSession,
  leaveSession,
  mintRoom,
  setRoomCode,
  subscribeSession,
  type SessionStatus,
} from './session'

export type { SessionStatus }

export type SessionInfo = {
  room: string
  status: SessionStatus
  /** True once a shared document is authoritative. */
  shared: boolean
  /** Number of participants including yourself. */
  peers: number
  error: string | null
  peerList: Presence[]
  /** True when this client adopted an existing remote patch on join. */
  adoptedRemote: boolean
  join: (room?: string) => void
  leave: () => void
  setRoom: (room: string) => void
  mintRoom: () => string
  copyInviteLink: () => Promise<void>
}

/**
 * Auto-join is attempted once per page load, not once per component: this hook
 * is called from both `App` and `SessionPanel`, and StrictMode runs every effect
 * twice. `joinSession` is itself idempotent, but latching here keeps the intent
 * obvious — following an invite link joins exactly once, and if the user then
 * leaves, mounting another panel does not silently drag them back in.
 */
let autoJoinAttempted = false

export function useSession(): SessionInfo {
  const state = useSyncExternalStore(subscribeSession, getSessionState, getSessionState)

  useEffect(() => {
    if (autoJoinAttempted) return
    autoJoinAttempted = true
    const invited = parseRoomParams().room
    if (invited !== null) joinSession(invited)
  }, [])

  return useMemo(
    () => ({
      room: state.room,
      status: state.status,
      shared: state.shared,
      peers: state.peers,
      error: state.error,
      peerList: state.peerList,
      adoptedRemote: state.adoptedRemote,
      join: joinSession,
      leave: leaveSession,
      setRoom: setRoomCode,
      mintRoom,
      copyInviteLink,
    }),
    [state],
  )
}
