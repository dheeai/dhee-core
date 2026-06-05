# LLM Context Bloat — Unbounded Prompt Growth in the Text Lane

- **Status:** open / investigating
- **Discovered:** 2026-06-04
- **Reporter:** external user report + usage-telemetry forensics
- **Severity:** high — metered LLM usage scales with input tokens, so an
  unbounded-growth session charges a user (or burns a free allowance) for
  re-processing the same context hundreds of times. Currently masked by a
  very cheap model; on a costlier model the same session is ~30–40× more
  expensive.

## Symptom

In a single ~2-hour session the **prompt (input) token count per LLM call
grew monotonically**, while output stayed tiny. The session made hundreds
of calls that, in aggregate, sent millions of input tokens to produce a
few tens of thousands of output tokens — i.e. almost all the spend was on
re-reading accumulated context, not on generating new content.

## Evidence (one real session, anonymized)

| Metric | Value |
|---|---|
| LLM calls | 233 |
| Prompt (input) tokens | ~14.1M |
| Completion (output) tokens | ~93K |
| **Input : output ratio** | **~152 : 1** |
| Cached input tokens | ~7.7M (**only ~54%**) |
| Model | a low-cost OpenRouter model |
| Cloud (image/video) jobs in session | **0** — the entire spend was text |

Average prompt size per call, bucketed over the session — note the smooth,
monotonic climb tracking **wall-clock time, not node type**:

```
14:18    6,300 tokens   ← healthy
14:43   17,400
14:50   44,300
15:21   71,400
15:40   87,000
16:00  112,300  (max 124,800)
16:10           (max 130,710)  ← ~125K tokens of context to emit a few hundred
```

The shape (hundreds of calls over hours, prompt size correlated with
elapsed time rather than which node is running) implicates the **chat-agent
conversation history** as the primary driver, with the walker's per-node
embedding as a strong secondary contributor.

## Root cause

### 1. Chat agent: unbounded conversation history (primary)

The in-process pi-agent accumulates the full message history and re-sends
it on every turn, with no per-turn trimming, summarization, or
sliding-window applied by dhee.

- `pi-agent-core`'s agent loop appends **every** tool result to
  `context.messages` and converts the entire history to LLM messages on
  each turn — no filtering of bulky results.
- dhee's `transformContext` hook in `src/agent/pi/buildSession.ts`
  currently passes history through unmodified (it only delegates to the
  extension runner, which applies no reduction). This is the natural place
  to insert a bound.
- Large tool results stay in history verbatim and are re-sent forever — in
  particular `src/agent/pi/tools/dheeShowNodeOutput.ts` can return whole
  node outputs (generated text, file contents) inline.
- Sessions persist as append-only JSONL (`src/agent/pi/sessionStore.ts`)
  and reload the full unbounded history on resume.
- Automatic compaction *does* exist in the underlying `pi-coding-agent`
  session (token-threshold-triggered), but it is not enabled/tuned for our
  sessions, so it only kicks in near context-window overflow — far past the
  point where cost has already ballooned.

### 2. Walker: full upstream outputs re-embedded per node + per-shot fan-out (secondary)

Each LLM node's prompt embeds the **full rendered outputs of all its
declared upstream dependencies**, and per-item collection nodes repeat that
for every item.

- `src/dag/walker.ts` (~1294–1443) resolves each declared input by reading
  the upstream node's entire output file and substituting it into the
  prompt; `src/dag/runners/llmGenerate.ts` (~184–206) does the literal
  template substitution.
- Late-stage per-shot nodes (e.g. `shot_image_prompt`, `shot_motion_directive`)
  inline the **entire `scenes_plan`** (all scenes + all shots) plus
  `world_style`, `characters_plan`, and `settings_plan` — then run once per
  shot, re-sending that whole blob each time.
- Retries compound it: `llmGenerate.ts` (~444–551, `maxRetries` default 2)
  appends the prior (large) response plus an error/schema-feedback message
  and re-sends on parse/schema failure; cascade invalidation can re-run
  nodes entirely.
- A full narrative bundle is already ~40+ LLM calls before retries; with
  per-shot fan-out and retries it climbs into the hundreds.

> Note: untracked WIP `src/dag/chunkDeps.ts` + `tests/dag/walkerChunkDepNarrowing.test.ts`
> suggest dependency-narrowing for the walker is already in progress — that
> directly addresses this mechanism for per-item nodes.

### 3. Prompt-cache misses (~54%) (compounding)

Even when context is re-sent, a stable prefix should cache cheaply. It
doesn't, reliably:

- `src/core/llm/LLMClient.ts` (~479–508) enables usage accounting
  (`usage: { include: true }`) but sets **no `cache_control` breakpoints** —
  it relies entirely on automatic prefix caching.
- The prefix isn't guaranteed stable: system messages are consolidated via
  `join('\n\n')` (~714–730) and tool definitions are re-serialized per call
  (~776–785); any per-call variance in system text or tool ordering breaks
  the cacheable prefix.
- Multi-minute gaps between calls also exceed typical prompt-cache TTLs, so
  a resent prefix that *should* hit instead misses at full price.

### 4. Per-call minimum (minor)

Each metered call rounds up to a 1-credit minimum, so a long tail of tiny
calls each costs the floor. Minor next to #1–#3, but real at high call
counts.

## Why it matters

- Billable LLM usage is a function of input tokens. Unbounded context means
  a user is charged for re-processing the same material hundreds of times —
  wasted spend and a poor experience (a user can exhaust an allowance
  without producing usable output, which is exactly what was reported).
- It's currently hidden by using a cheap model. The same session on a
  premium model would cost ~30–40× more — a latent landmine for any
  premium/orchestrator lane.
- For local-first users (their own ComfyUI doing image/video), text
  orchestration is the *only* metered cost, so this bug is the single
  biggest lever on how far an allowance goes.

## Fix plan (prioritized; estimates are agent-days-to-verified)

The binding constraint on all of these is **verification** — confirming the
agent/walker still produce correct output after we cut context — not the
code change itself.

0. **Instrument first (½ day).** Tag `usage_events` with a session id and
   the originating node/turn so we can confirm the chat-agent-vs-walker
   split quantitatively before optimizing. (Recording lives in the hosted
   proxy repo; the client can attach the tag.)

1. **Bound the chat context (1–2 days) — biggest win.** In
   `src/agent/pi/buildSession.ts`, implement `transformContext` to cap the
   history sent per turn: enable/tune the existing token-threshold
   auto-compaction *well below* the context window, and/or a sliding window
   that keeps the system prompt + recent turns + a running summary. Verify
   the agent retains enough state to keep operating across a long session.

2. **Evict bulky tool results from history (1 day).** After a large tool
   result (node output, file dump) has been shown once, replace it in
   re-sent history with a compact reference/summary instead of the verbatim
   blob. Hook point: a context handler registered alongside the dhee tools
   (none is registered today), or within the `transformContext` from #1.

3. **Narrow walker per-item dependencies (1–3 days; partly in progress).**
   For per-shot/per-scene collection nodes, pass only the matching item's
   slice of `scenes_plan` rather than the whole plan. The `scope: 'matching'`
   / `itemId` machinery already exists; the `chunkDeps` WIP appears aimed
   here. Verify per-shot prompts still have the grounding they need.

4. **Make prompt caching reliable (1–2 days).** Add `cache_control`
   breakpoints on the stable prefix in `LLMClient.ts`, guarantee a
   deterministic system-prompt + tool ordering, and confirm cached-token
   ratio rises materially on resent context.

5. **Revisit the per-call minimum (small).** Decide whether the 1-credit
   floor is intended; lives in the hosted proxy/pricing repo.

## Done criteria / how we'll know it's fixed

- A long agent session keeps per-call prompt size **bounded** (e.g. a flat
  ceiling rather than a monotonic climb) — verifiable from the same
  per-call telemetry that surfaced this.
- A representative end-to-end narrative run consumes input tokens on the
  order of the work performed (target: input:output ratio in the low single
  digits, not ~150:1), with cached-token ratio materially above today's
  ~54% on resent context.
- A regression test asserts that an N-turn agent session does not grow
  per-turn prompt tokens past a configured bound.

## Related

- `todos/approval-gates.md` — the user's "pause after each phase for a human
  to check" request maps to the approval-gate / candidate-tray UX, and an
  approval gate also naturally caps runaway spend.
- Image/video regeneration loops (a separately reported issue) compound cost
  on the cloud lane the same way retries compound it here.
