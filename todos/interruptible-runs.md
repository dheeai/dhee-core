# Interruptible runs — agent decides whether to abort

Branch: `feat/interruptible-runs` (both kshana-core + kshana-desktop)

## Problem

When the user types while a bundle is running, the desktop **always** aborts
the run (`handleSend` → `session.cancel()` → `cancelTask`). That's wasteful:
a mundane question ("how long left?", "what's shot 3 about?") kills a
multi-minute run for nothing.

Root cause — not a UX choice, an architectural constraint:
`dhee_run_bundle` (`dheeRunBundle.ts:137`) returns a Promise that resolves
only on the run's terminal event. So for the entire run the agent turn is
**suspended inside that tool call** — the LLM can't read a new message until
the tool resolves. The only way the renderer can get a new message processed
is to cancel the run first (which resolves the awaited `cancelled` event and
frees the agent). Hence "type = abort."

## Target behavior

- Run executes in the background; the **agent stays idle/free** during it.
- User types mid-run → message reaches the live agent → agent **decides**:
  - mundane question → answer from `dhee_get_status`, **run keeps going**;
  - substantive redirect ("shot 3 is warped") → `dhee_stop_run`, fix the
    upstream node (`dhee_critique_node` / `dhee_write_node_content`),
    `dhee_start_run` to resume (walker skips the good shots).
- The top **Stop button stays** as the always-available hard abort (renderer
  → `cancelTask`, no LLM in the loop, instant).

## Key architectural facts (verified)

- `BackgroundTaskRunner.dispatch()` returns immediately with `{started, taskId}`
  or `{rejected, activeTaskId}` — single-flight (rejects a 2nd concurrent run).
  `on('completed'|'failed'|'cancelled', h)` with payload `{task, error?}`.
  `cancel()` aborts the active AbortController synchronously; the **slot frees
  only in `runActive()`'s `finally`** after the executor notices `signal.aborted`
  (can take seconds).
- Singleton: `getBackgroundTaskRunner()` (`backgroundTaskRunnerSingleton.ts`),
  shared in-process by desktop + headless.
- AbortSignal threads: dispatch → `executeRunTo` → `runProjectViaBundle(signal)`
  → `walkBundle(signal)` → `ctx.signal` in runners. `cancel()` aborts it.
- Desktop agent entry: `dheeCoreManager.chatPrompt(sessionId, message, eventCb)`
  → `runAgentTurn`. `session.status` ('running'|'idle') reflects the AGENT turn,
  set in `useDheeSession` chatPrompt hook — **distinct** from the status strip's
  "Running" which reflects the RUNNER task (separate subscription).
- `dheeCoreManager.runTask` already subscribes to runner events + forwards to the
  renderer via `eventCb` → `dhee:event`. This is the hook point for re-wake.
- `cancelTask(sessionId)` = `runner.cancel()` + `session.abort()`, both
  fire-and-forget.

The unlock: **non-blocking dispatch makes `session.status` go back to idle the
moment the run starts** (the agent turn ends after dispatch). So when the user
types during a run, `handleSend`'s existing `if (status==='running') cancel()`
guard naturally does NOT fire — the message reaches the idle agent. Most of the
renderer change is "verify, don't break."

---

## Phases (TDD red→green, commit per phase)

### Phase 1 — core: `dhee_start_run` + `dhee_stop_run` tools

New files:
- `src/agent/pi/tools/dheeStartRun.ts` — non-blocking sibling of `dhee_run_bundle`.
  `dhee_start_run(projectDir, stopAt?, runOnly?)` → `runner.dispatch(...)`,
  returns IMMEDIATELY: `started (taskId)` or `rejected (activeTaskId)`. Does NOT
  await a terminal event.
- `src/agent/pi/tools/dheeStopRun.ts` — `dhee_stop_run(projectDir?)` →
  `runner.cancel()`, then **await the active task's `cancelled` event** (bounded
  by a timeout, e.g. 15s) so a subsequent `dhee_start_run` won't hit the
  single-flight `rejected`. Returns `{stopped: true, taskId}` or
  `{stopped: false, reason: 'no active run'}`.

Keep `dhee_run_bundle` (blocking) for headless/CLI where there's no human to
interject — both registered.

Wire into `tools/index.ts` + `DHEE_TOOL_NAMES` (+ update `dheeAgentTools.test.ts`
expected list).

Failure modes to test (injected runner stub):
1. `start_run` on a fresh project → `started`, taskId returned, returns before
   any terminal event (assert the dispatch stub's terminal handler was never
   awaited).
2. `start_run` when a run is active → `rejected` with activeTaskId.
3. `start_run` missing project.json → error.
4. `stop_run` with an active task → calls `cancel()`, resolves after `cancelled`
   event, returns `{stopped:true}`.
5. `stop_run` with NO active task → `{stopped:false}` immediately, no throw.
6. `stop_run` cancel that never emits `cancelled` within timeout → returns
   `{stopped:true, note:'timeout'}` (don't hang the agent forever).
7. stop → start sequencing: after `stop_run` resolves, `start_run` is NOT
   rejected (slot freed).

### Phase 2 — desktop: re-wake the agent on terminal run events

**Reconciliation principle.** In the old blocking model the agent could not be
wrong about run state — it was parked inside the tool call. Non-blocking lets
the agent's mental model drift ("is a run still going?"). Two defenses, layered:
1. **Push** — wake the agent on terminal events (below).
2. **Pull** — SKILL rule (Phase 4): on ANY message, if a run might be live, call
   `dhee_get_status` first. `walkState` / events.jsonl are ground truth, so even
   a missed nudge self-heals on the next turn. The push is the good UX; the pull
   is the safety net.

**The runner already guarantees exactly one terminal event per run** —
`BackgroundTaskRunner.runActive()` try/catch/finally:
- walk succeeds → `completed`
- walk returns `{ok:false}` → `executeRunTo` THROWS (`executeRunTo:55`) → `failed`
- retry-exhausted / unexpected throw → `failed`
- `signal.aborted` (either branch) → `cancelled`
- executor returns `{cancelled:true}` → `cancelled`

No silent-death path. So wiring the three terminal events covers every exit.

In `dheeCoreManager.ts`, subscribe (once) to the runner terminal events for runs
**owned by an agent session** (tag dispatches from `dhee_start_run` with the
originating chat sessionId — thread the real sessionId through the dispatch
`sessionId` field; today it's a basename string).

**On `failed` (the important error path)** — wake the agent with a RICH nudge so
it can pick the right response, not just "it broke":
- the failed **node id + itemId** (e.g. `shot_image:scene_1_shot_5`);
- the **error string**;
- a **retryable hint** — was it transient (network / Comfy 502 / retry-exhausted
  → "endpoint was flaky, offer to retry") vs structural (malformed prompt,
  missing input → "fix the upstream node")? Derive from the error text +
  `transientRetry`'s "transient upstream error after N attempts" marker.
- Nudge text e.g.: `"[system] Run failed at shot_image:scene_1_shot_5 — transient
  upstream error after 3 attempts (Comfy 502). The endpoint may have recovered;
  ask the user whether to retry, or check dhee_get_status."`

**On `completed`** — nudge: `"[system] Run completed. Final video at <path>. Tell
the user; do not start another run unless asked."`

**Idle vs busy:**
- session **idle** → inject the nudge via `chatPrompt(sessionId, nudge)`.
- session **busy** (mid-turn on a user redirect) → **skip** the push; the pull
  (dhee_get_status) covers it. Log the skip.

**On `cancelled` — deliberately NO auto-nudge**, because cancellation always
already has a driver:
- Stop button → `cancelTask` also fired `session.abort()`, killing the agent
  turn; the user's next message wakes it normally. A nudge would race the abort.
- Agent self-stop (`dhee_stop_run` during a redirect) → the agent is mid-turn and
  about to call `dhee_start_run`; waking it "cancelled" is confusing noise.
- Navigation / shutdown → nothing to wake.
(The pull safety net still applies: if the agent ever wonders, `dhee_get_status`
tells the truth.)

Guards:
- de-dupe: one nudge per terminal event (`matches(taskId)`).
- no-loop: nudges are informational; SKILL says "announce, don't auto-start."

Failure modes to test (dheeCoreManager test, injected runner + fake session):
1. `completed` while idle → `chatPrompt` called once, nudge names the video path.
2. `failed` (structural) while idle → nudge carries node id + error + "fix
   upstream" framing.
3. `failed` (transient — error contains "transient upstream error after") while
   idle → nudge carries the "may have recovered, offer retry" framing.
4. terminal event while session **busy** → `chatPrompt` NOT called (skipped).
5. `cancelled` → never nudges (all three sub-cases).
6. terminal event for a run with NO owning agent session (headless dispatch) →
   no nudge, no throw.
7. **Terminal-event exhaustiveness** (guard against silent death): a table-driven
   test feeding the runner each executor exit — returns void, returns
   `{cancelled:true}`, throws Error, throws after `signal.aborted` — asserts
   exactly one of `completed`/`failed`/`cancelled` fires each time, and the
   nudge decision matches. This is the "every abort path is wired" guarantee,
   made executable.

### Phase 3 — desktop: confirm renderer no longer auto-aborts the RUN

With non-blocking dispatch, `session.status` is idle during a background run, so
`handleSend`'s `if (status==='running') session.cancel()` only fires when the
AGENT is genuinely mid-turn (correct — that interrupts the agent's *thinking*,
not the run).

- Verify (test) `handleSend` does NOT call cancel when a run is active but the
  agent is idle.
- Status strip "Running" must reflect the RUNNER task, independent of agent
  status (already a separate subscription — assert it stays Running while the
  agent is idle).
- Chat input stays enabled (already gated on `!isReady`, not run state).
- Project-switch guard ("a run is in progress, going back cancels it") — keep
  as-is; navigation away is still a legit hard cancel.

Failure modes to test (ChatPanelEmbedded test):
1. run active + agent idle + user submits → `session.cancel()` NOT called; message
   dispatched via `chatPrompt`.
2. agent mid-turn + user submits → `session.cancel()` IS called (interrupt the
   agent), then dispatch (existing behavior preserved).

### Phase 4 — core: SKILL.md guidance (behavior layer)

Add an "Interactive runs" section:
- In the desktop, prefer `dhee_start_run` (non-blocking) so you stay responsive;
  the run continues in the background and you'll be nudged when it finishes.
  (`dhee_run_bundle` is the blocking variant — only for non-interactive/headless.)
- **Safety net (the "pull"):** on ANY message, if a run might be live OR you're
  unsure of run state, call `dhee_get_status` FIRST — walkState is ground truth,
  so your view never drifts even if a completion/failure nudge was missed.
- When a message arrives and a run may be in flight: call `dhee_get_status`
  first. Then decide:
  - mundane / informational ("how long?", "what's shot 3?") → answer, **leave
    the run running**. Never stop a run for a question.
  - substantive redirect about an artifact ("shot 3's face is warped", "make the
    setting darker") → `dhee_stop_run`, fix the upstream LLM prompt node
    (`dhee_critique_node` for prompt fixes, `dhee_write_node_content` for
    user-supplied content), then `dhee_start_run` to resume. The walker skips
    completed shots — only the fixed node + its downstream re-run.
- Never restart the whole bundle to fix one shot.

### Phase 5 — e2e: drive-test from the desktop (the "works e2e" requirement)

Use a **fast deterministic bundle** (e.g. `narrative_text_only` / a stub-runner
bundle) so the run lasts long enough to interrupt but doesn't need GPU.

`pnpm drive` (headless agent) sequence, asserting tool_calls each step:
1. Send "make a short video about X" → agent calls `dhee_start_run`, returns
   promptly (turn ends, run backgrounded).
2. Mid-run, send "how many shots are there?" → assert agent calls
   `dhee_get_status` and does NOT call `dhee_stop_run`; run still active.
3. Mid-run, send "shot 2 looks wrong, make it brighter" → assert agent calls
   `dhee_stop_run` then `dhee_critique_node`/`dhee_write_node_content` then
   `dhee_start_run`; assert shots other than 2 are NOT re-run (walkState skip).
4. Let it finish → assert the re-wake nudge fires and the agent announces
   completion.

Then the **desktop UI** loop (`desktop-drive` / iterate-ui): start a run from
chat, watch the Cards view update live, type a mundane question (run continues),
type a redirect (run stops + redoes + resumes), screenshot each state. This is
the literal user scenario.

---

## Risks / tradeoffs

- **Lost single-turn narration.** Today the agent "watches" the run inside the
  blocking tool. Non-blocking means it only learns of completion via the Phase-2
  re-wake — so Phase 2 is load-bearing, not optional.
- **Stop→start sequencing.** `dhee_stop_run` must await the `cancelled` event
  before returning, else `dhee_start_run` hits single-flight `rejected`. Bounded
  by timeout so a stuck abort doesn't hang the agent.
- **Race window.** Between the user typing and the agent deciding to stop, the run
  advances a node or two — occasionally finishing the very shot about to be
  killed. Acceptable.
- **Nudge while busy.** If a terminal event lands while the agent is mid-turn,
  we skip the nudge (agent reads state via `dhee_get_status`). No queue in v1.

## Out of scope (v1)

- Queuing deferred nudges (drop-if-busy is fine for v1).
- Streaming the agent's "decision" reasoning as it classifies the message.
- Tap-a-card-to-redirect UX affordance (separate follow-up; this plan is the
  type-to-redirect path).
