# SpAIglass Workplan

## Loose Ends (from 2026-04-18 session)

### 1. spaiglass-developer systemd service
- **Status:** Running as nohup processes (will die on reboot)
- **What:** Backend on port 8090 + connector process for the `spaiglass-developer` relay connector
- **Fix:** Create a systemd unit (or extend existing service config) so it survives reboots
- **Connector ID:** `c588537b-fe4f-4fbe-a53d-03ffd02a8b14`
- **Token in:** `/home/johntdavenport/projects/spaiglass/backend/.env`

### 2. deploy-relay.sh --frontend not pushing builds
- **Status:** Broken — script completes but doesn't upload the new frontend bundle
- **What:** `deploy-relay.sh --frontend` reports success, relay still serves old `index-*.js`
- **Workaround:** Manual `scp -r frontend/dist/* root@137.184.187.234:/opt/sgcleanrelay/frontend/`
- **Fix:** Debug the script's upload step; likely a path or rsync issue

### 3. Stale asset cleanup on relay
- **Status:** 47+ old `index-*.js` files in `/opt/sgcleanrelay/frontend/assets/`
- **What:** Every deploy adds new hashed files, nothing removes old ones
- **Fix:** Add a cleanup step to deploy-relay.sh that removes `assets/index-*.js` and `assets/index-*.css` before uploading new ones (keep only the files referenced by the new `index.html`)

### 4. Verify universal focus fix
- **Status:** Deployed, untested
- **What:** Added `focusout` listener in `ChatInput.tsx` that returns focus to textarea when it falls to `document.body` (modal/dialog close). Replaces the whack-a-mole `focusTrigger` approach.
- **Test:** Open Session Picker > Cancel > verify cursor is in textarea. Repeat for Settings modal, Context picker, Fleet dropdown.

### 5. Verify display name fix for recent agent buttons
- **Status:** Deployed, untested
- **What:** Fixed URL mismatch in relay's fleet roles endpoint (`server.ts`). Role URLs were built with bare connector name instead of full `login.name` slug, so `AgentSwitcher`'s `roles.find(r => r.url === agent.url)` never matched.
- **Test:** Change a project display name in Settings > General > verify the recent agent buttons at the top of the page update to show the new display name (not the canonical directory name).

---

## Feature Gaps: Spaiglass vs Claude Code CLI

Identified 2026-04-18 by comparing the mid-turn messaging flow and general feature parity.

### Gap 1: No queue feedback for `/btw` and mid-turn messages
- **CLI behavior:** Message sits in TUI input buffer; minimal feedback but the linear flow makes it implicit
- **Spaiglass behavior:** `/btw` message vanishes from textarea with zero visual confirmation it was queued
- **Fix:** Show a transient toast or subtle "queued" badge when a message is pushed while `isLoading === true`. For `/btw`, synthesize a local echo frame immediately (like normal messages do) so the user sees what they sent.
- **Files:** `frontend/src/components/ChatPage.tsx` (sendMessage function, `/btw` handler around line 530-540), `frontend/src/terminal/frames/state.ts` (if adding a new frame type)

### Gap 2: No queued message visibility or management
- **CLI behavior:** Same gap (CLI issue #36817)
- **Spaiglass behavior:** No way to see pending messages in the queue, cancel them, or reorder them
- **Fix (light):** Show a small "N messages queued" indicator near the input bar when `isLoading && queuedCount > 0`
- **Fix (full):** Expandable queue panel showing pending messages with cancel buttons
- **Files:** Backend would need a `GET /api/session/queue` or WebSocket query to expose queue depth. Frontend would need a queue indicator component.

### Gap 3: `/btw` echo delay
- **CLI behavior:** N/A (TUI doesn't show inline echoes)
- **Spaiglass behavior:** Normal messages get instant local echo in scrollback. `/btw` messages don't — they only appear when the backend echoes them after Claude reads from queue.
- **Fix:** Synthesize a local `user_message` frame for `/btw` the same way normal messages do (ChatPage.tsx line 580-613). Mark it as a side-message visually (e.g., dimmer text, italic, or a `/btw` label).
- **Files:** `frontend/src/components/ChatPage.tsx` (add local echo to `/btw` handler)

### Gap 4: Slash commands in queue treated as literal text
- **CLI behavior:** Same gap (CLI issue #18399) — `/reset` sent while Claude is working gets treated as raw text, not executed as a command
- **Spaiglass behavior:** `/stop` and `/reset` are handled client-side before reaching the queue, so they work correctly. But any OTHER slash command sent mid-turn would be queued as text.
- **Current state:** Actually OK for spaiglass — the important commands (`/stop`, `/reset`, `/btw`) are intercepted client-side. Other slash commands (`/compact`, etc.) are SDK-level and the SDK handles them from the queue correctly. **Low priority.**

### Gap 5: Black Glass theme refinement
- **What:** Black Glass is now the default theme. Need to verify it looks correct across all UI states: settings modal, session picker, fleet dropdown, permission panels, file editor, architecture viewer, error notices, recap row.
- **Test plan:** Walk through every UI surface with Black Glass active and note any elements that still use light-mode colors or look broken against `#000000` background.

### Gap 6: Recap row only shows stats, not summary text
- **What:** The `※` recap row shows duration/tokens/cost but NOT the text summary Claude shows in CLI (e.g., "Hardened all 9 machines..."). The SDK `result` message doesn't include that text — it's generated by the CLI's display renderer.
- **Options:**
  - (a) Accept stats-only (current) — honest representation of what the SDK provides
  - (b) Ask Claude to generate a 1-line summary as part of its response (prompt engineering in the system message or role file)
  - (c) Generate a summary client-side from the last assistant message (truncate to first sentence or heading)
- **Recommendation:** Option (a) for now. The stats are useful. If the user wants text summaries, option (b) is the cleanest.

---

## Priority Order

1. Loose ends 1-3 (infrastructure reliability)
2. Loose ends 4-5 (verify deployed fixes)
3. Gap 1 + Gap 3 (queue feedback + /btw echo — quick wins, big UX improvement)
4. Gap 5 (Black Glass audit — visual polish)
5. Gap 2 (queue visibility — medium effort)
6. Gap 6 (recap text — deferred, stats-only is fine)
7. Gap 4 (slash commands in queue — low priority, mostly handled)
