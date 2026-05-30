# P1 — Session resumption: finish & verify

**Date:** 2026-05-30
**Status:** approved, in progress
**Scope:** Close the remaining gaps in session-resumption-after-disconnect and lock the behavior down with tests. This is NOT a greenfield build — the feature is ~85–90% implemented.

## Background

Goal: when a browser disconnects mid-session (laptop sleep, network change, tab reload), the Claude process on the host keeps running and the browser re-attaches to the SAME session, replaying any frames it missed — no fresh session, no lost output.

A code audit (2026-05-30) found the feature largely built:

| Piece | File | Status |
|---|---|---|
| In-memory ring buffer | `backend/session/buffer.ts` | done, unit-tested |
| Disk-backed frame log + `readFramesAfter` | `backend/session/persistence.ts` | done |
| Resume protocol (`handleResume` → `resumeFromCursor`, `resume_ack`/`failed`/`lost`, disk fallback) | `backend/session/ws-handler.ts`, `backend/session/manager.ts` | done |
| Relay preserves connector session on browser drop | `relay/src/tunnel.ts` | correct |
| Frontend auto-reconnect + backoff + `resume{lastCursor}` | `frontend/src/hooks/useWebSocketSession.ts` | done |
| Reducer seq-dedup of replayed frames | `frontend/src/terminal/frames/state.ts:266` | done |
| History hydration seeds reducer `lastSeq` | `frontend/src/hooks/chat/useFrameChatState.ts` | done |

## Verified behaviour (two reconnect scenarios)

1. **Within-lifetime reconnect** (WS drops, page stays mounted): `ws.onopen` sees `lastSessionParamsRef` set and sends `resume{lastCursor: lastCursorRef.current}`. `lastCursorRef` holds the live max-seq (updated per inbound frame at `useWebSocketSession.ts:242`), so the backend replays only `seq > lastCursor`. Works and is efficient.

2. **Page reload / fresh mount**: `lastSessionParamsRef` is null, so the resume protocol is not used. Scrollback is rebuilt from the history endpoint (`loadFrames` → `buildFrameState`, which seeds reducer `lastSeq`), and `startSession` re-attaches for live frames. The reducer's seq-dedup prevents duplicate rows regardless.

## Known / suspected gaps

- **G1 — Page-reload frame-gap race (suspected):** between the history-endpoint read and the `startSession` re-attach, frames the host emits in that window could be missed (history snapshot is slightly stale; startSession streams from "now"). Needs a test to confirm whether it's real.
- **G2 — No integration test** for `resumeFromCursor` (live buffer + disk fallback + cursor slicing) or for the frontend replay→dedup path. Buffer/reducer units are tested in isolation; the wiring is not.
- **G3 — Terminology:** backend "cursor" vs frontend/reducer "seq" are the same value; cosmetic only. Out of scope unless it obstructs a fix.

## Approach (test-first)

1. **Backend integration test** for `resumeFromCursor`: build a session with N persisted frames, resume with `lastCursor = k`, assert exactly the `seq > k` frames replay; assert disk fallback when the in-memory cursor is aged out (`isCursorLost`); assert `resume_failed` when nothing exists.
2. **Frontend replay test**: drive the reducer with an initial frame run, then a resume replay that overlaps, and assert no duplicate rows and correct final scrollback (extends the existing `state.test.ts` dedup coverage to the resume shape).
3. **Confirm or refute G1** via the tests above / a targeted read of the `startSession` re-attach path. **Fix only if confirmed.** If real, the minimal fix is to route page-reload re-attach through the same cursor-based replay (seed the resume cursor from the hydrated history's max seq via a new `seedCursor(seq)` on the WS hook, called after `loadFrames`).
4. **Live verification:** controlled disconnect/reconnect against the production relay using a private screenshot session (non-disruptive — does not touch other users' sessions).
5. **Deploy:** the backend change ships via the proper bun-binary release (`deploy-relay.sh --binaries` + fleet install.sh re-run), batched as the real backend release the fleet needs. No deploy if step 3 finds no backend change is required.

## Non-goals

- No rewrite of the resume protocol — it's sound.
- No cursor/seq rename (G3) unless a fix forces it.
- No multi-browser concurrency changes.

## Done when

- `resumeFromCursor` and the frontend replay→dedup path have passing integration tests.
- A live disconnect→reconnect replays missed output with no duplicate or lost rows (verified, with evidence).
- Any confirmed gap (G1) is fixed and deployed; if none, that's recorded explicitly.
