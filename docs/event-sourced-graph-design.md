# Event-Sourced Reactive Graph — Design

**Status:** Design / proposal. Post-launch foundational work (concept ③).
Not launch-blocking. Subsumes the two lighter todos:
`todos/content-addressed-generation-cache.md` (①) and
`todos/non-destructive-fork-and-versions.md` (②).

## Motivation

Today the engine's runtime state is a **mutable snapshot**: `walkState` lives at
`project.json.walkState`, the walker mutates instance `status` in place and
overwrites the snapshot after each node (`walker.ts` ~L935), and regen is
destructive (`projectRegen.ts:144` `unlinkSync` + recompute). Two hard limits
follow:

- **Limit A** — one output per node; regen destroys the prior one. The project
  can never hold two realities at once (no best-of-N, no branches, no undo).
- **Limit B** — the cache is path-based, so a generation can't be found, reused,
  or reproduced by its *inputs*.

This design replaces "the snapshot is the truth" with **"an append-only event
log is the truth; every view — including `walkState` — is a projection of it."**
That unlocks: non-destructive best-of-N + branches (②), input-keyed cache +
free replay (①), full lineage/provenance, time-travel, and — the strategic
payoff — a creative UX (version-history scrubber, multiverse branch board,
candidate tray, lineage inspector, live cost ledger) that competitors can't
match, because *any* UI view is just another projection.

## Core model

```
            append-only event log  (the source of truth)
                       │
            project()  │  deterministic fold
                       ▼
   ┌───────────┬───────────┬────────────┬───────────┬─────────────┐
   │ walkState │  board    │  timeline  │  lineage  │  cost ledger │   ← projections (read models)
   └───────────┴───────────┴────────────┴───────────┴─────────────┘
```

- **Behaviors emit events; events fold into projections; the agent and UI read
  projections.** Nothing reads or writes the snapshot directly anymore — the
  snapshot (`walkState`) becomes one derived projection among many.
- **Single-writer discipline is preserved.** Today "the walker writes walkState
  exclusively." Tomorrow: a single **append API** is the only writer of the log;
  the walker, regen, and agent tools all append through it.

## Event schema

One JSON object per event. Envelope is fixed; `payload` is per-kind.

```typescript
interface DheeEvent<K extends EventKind = EventKind> {
  seq: number;                 // monotonic per-project sequence (ordering + cursor)
  id: string;                  // nanoid (stable id for causal refs)
  ts: number;                  // unix-ms (informational; NOT used for ordering)
  branchId: string;            // which branch this event belongs to ('main' default)
  parentEventId?: string;      // causal parent; for branch roots = the fork point
  actor: 'walker' | 'agent' | 'user' | 'runner';
  kind: K;
  payload: EventPayload[K];
}

type EventKind =
  | 'project.created'
  | 'bundle.bound'             // a bundle source+version was attached to the project
  | 'node.started'            // walker began a node instance
  | 'node.completed'          // produced an artifact (carries content hash → ①)
  | 'node.failed'
  | 'node.invalidated'        // regen/cascade marked an instance stale (NON-destructive)
  | 'version.added'           // a new candidate version for a node instance (②)
  | 'version.selected'        // taste-gate pick; downstream consumes this version (②)
  | 'branch.created'          // fork from a point (②)
  | 'critique.added'          // judge verdict on an instance (existing reviewLoop concept)
  | 'inputs.provided';        // bundle-level inputs (story text, target duration…)
```

Key payloads:

```typescript
interface NodeCompletedPayload {
  nodeId: string;
  itemId?: string;             // collection instance, e.g. 'scene_1_shot_3'
  versionId: string;          // the version this completion produced (②)
  artifact: {
    storeHash: string;        // content-addressed key (ties to ①); artifact in CAS
    format: 'md'|'json'|'image'|'video'|'audio'|'text';
    bytes: number;
  };
  generation?: {              // present for model/GPU runners
    tool: string;             // runner tool, e.g. 'comfy.klein'
    toolVersion: string;
    inputsHash: string;       // hash of resolved inputs (① cache key)
    seed?: number|string;     // pinned seed → reproducibility
    costUsd?: number;         // → cost ledger projection
    cached: boolean;          // served from CAS (no new model call) vs computed
  };
  metadata?: Record<string, unknown>;
}

interface VersionSelectedPayload { nodeId: string; itemId?: string; versionId: string; }
interface BranchCreatedPayload   { branchId: string; label?: string; forkedFromEventId: string; }
```

**Causal, not wall-clock, ordering.** `seq` orders events; `ts` is informational
(replay must not depend on it — see the determinism note). `parentEventId` gives
the causal DAG needed for branches and lineage.

## How the event log is SAVED (persistence)

**Source of truth: an append-only JSONL file per project**, one event per line,
at `<projectDir>/.dhee/events.jsonl`. Rationale:

- **Local-first + matches the existing file-based model** (no new infra; the
  engine has no SQLite usage today despite the dep).
- **Human-inspectable + git-friendly** — diffs are append-only, mergeable.
- **Append is cheap and crash-safe** — `O(1)` write; a torn last line on crash
  is detectable and dropped on read (same tolerance `loadWalkState` already has
  for malformed JSON).
- **Fork is trivial** — a branch is just events tagged with a new `branchId`
  whose root carries `forkedFromEventId`; the shared prefix is not copied.

Write path:

```typescript
interface EventLog {
  append(e: Omit<DheeEvent, 'seq'|'id'|'ts'>): DheeEvent;   // assigns seq/id/ts, fsyncs the line
  read(opts?: { sinceSeq?: number; branchId?: string }): Iterable<DheeEvent>;
}
```

- `append` is the **single writer**. It assigns the next `seq`, appends one
  framed JSON line, and `fsync`s (or batches per walk-step). Concurrency within
  one process is serialized by the single walker; cross-process is guarded by a
  lockfile (the engine is single-process per project today).
- **Artifacts are NOT in the log.** The log stores only the **content hash**
  (`storeHash`); bytes live in the content-addressed store (① ` ~/.kshana/cache/`
  or `<projectDir>/.dhee/cas/`). This keeps the log small and makes free replay
  possible.

**Derived index (optional, later): SQLite** (`better-sqlite3` is already a dep).
A `projections.sqlite` rebuilt by folding the log — used for fast queries
(current status, lineage, cost) without re-reading the whole JSONL each time.
The DB is *disposable*: delete it and it rebuilds from the log. The JSONL log is
always the truth.

**Determinism contract (enables replay-without-recompute):** replaying the log
through `project()` plus the content-addressed cache reproduces every artifact
with **no new model calls** — because each `node.completed` carries the
`inputsHash` + pinned `seed`, so the CAS serves the exact bytes. Replay must be
a pure fold over `seq` order; it must not read `ts`, `Date.now()`, or
filesystem mtimes.

## The projection layer

A projection is a pure fold `(events) → readModel`. Built incrementally
(advance a cursor as new events append) and cached in the SQLite index.

- **`walkState` projection (the migration bridge).** `projectWalkState(log) →
  WalkState` produces the *exact existing shape*. The walker keeps calling
  `saveWalkState` with the projected snapshot, so **every current reader keeps
  working unchanged** (`dheeGetStatus`, the desktop, the scripts). This is what
  makes the cutover incremental rather than a big-bang rewrite.
- **Board / timeline** — group completed `node.completed` artifacts by
  `displayCapability` (the contract already in `schema.ts`); the timeline orders
  `scene.video`/`final.video` capabilities. Both already have a partial home in
  the desktop's capability-based rendering — they just read a projection instead
  of a snapshot.
- **Lineage** — walk `parentEventId` + the bundle's `inputs[].from` edges
  backward from any artifact to its ancestry.
- **Branch tree** — fold `branch.created` events into a tree of `branchId`s,
  each resolving to its latest `final.video` for a thumbnail.
- **Cost ledger** — sum `generation.costUsd` grouped by branch; count
  `cached:true` to show savings.

## Points of integration (with the current codebase)

1. **`walker.ts` — the emitter (primary change).** Where it mutates `inst.status`
   and calls `saveWalkState` (~L877 load, ~L935 save, ~L1240 completion), it
   instead `append()`s `node.started` / `node.completed` / `node.failed`, then
   writes the *projected* `walkState` for back-compat. The walk loop, resume,
   and chunking logic are otherwise untouched — resume reads the projection.
2. **`projectRegen.ts` — non-destructive.** `invalidateNodes` stops
   `unlinkSync` (L144); it appends `node.invalidated`. `regenerateNode` produces
   a new `version.added` rather than overwriting. Reuses `computeCascadeImpact`
   (`cascadeImpact.ts`) to scope what a fork re-runs.
3. **Runners (`llmGenerate.ts`, `comfyImage.ts`, `comfyLtxDirector.ts`).** Their
   existing path-based "cache hit" becomes a CAS lookup keyed by `inputsHash`
   (①). On completion they return `storeHash` + `generation{…}` which the walker
   puts into the `node.completed` payload. The `metadata.cached` hook already
   exists.
4. **Agent tools (`src/agent/pi/tools/`).** Read tools become projection
   queries; mutating tools become event appenders (see below). No agent code
   reaches around the tool boundary, so the agent↔log contract is clean.
5. **Desktop / frontend.** Switches from reading the `walkState` snapshot to
   subscribing to projections; gains the new views (history, branches, lineage,
   cost) for free as additional projections. `displayCapability` tags already
   decouple rendering from node ids.
6. **`walkState.ts`.** `NodeStateEntry` gains `versions[]` + `selectedVersionId`
   (②); `loadWalkState` becomes "project from log" with a one-time migration of
   legacy single-`outputPath` snapshots into a one-version, selected entry.

## How the agent READS the log

The agent reads **projections through tools**, never the raw file (keeps it
model-agnostic and safe). Existing tools map directly:

- `dheeGetStatus` → the `walkState` projection (current per-node status) — works
  as-is.
- `dheeShowNodeOutput` / `dheeReadArtifact` → resolve a capability/artifact from
  the projection + CAS.

New read tools the projections make possible (each is a thin projection query):

- `dheeListVersions(nodeId, itemId?)` → the candidate tray: all versions for an
  instance with provenance (runner/op/seed/cost) and which is selected. *This is
  what lets the agent run best-of-N and pick.*
- `dheeLineage(artifactRef)` → the ancestry path (clip ← keyframe ← prompt ←
  ref ← beat). For debugging hallucinations + explaining decisions.
- `dheeBranches()` → the branch tree with per-branch final-cut refs.
- `dheeHistory(sinceSeq?)` → recent events as a narratable activity feed.
- `dheeCost(branchId?)` → spend + cache-savings ledger.

So the agent's working memory *is* the log: "I generated 4 keyframes for shot 3
(`dheeListVersions`), the 2nd had a hand artifact (`dheeLineage`), I re-oriented
with Qwen and selected v4."

## How the agent CREATES events

**The agent never appends to the log directly.** It expresses *intent* via tools;
the tools/walker are the only appenders. This preserves the single-writer
integrity and keeps every event attributable (`actor:'agent'`) without letting a
model corrupt the log. Intent → event mapping:

| Agent tool (intent) | Events appended (by the tool/walker) |
|---|---|
| `dheeCreateProject` | `project.created`, `inputs.provided` |
| `dheeRunBundle` | `bundle.bound`, then per node `node.started` / `node.completed` / `node.failed` (emitted by the walker) |
| `dheeRegenerateNode` | `node.invalidated` + (on re-run) `version.added`, `node.completed` |
| `dheeCritiqueNode` | `critique.added` (+ may trigger invalidate/re-walk) |
| **new** `dheeSelectVersion` | `version.selected` — the taste-gate pick |
| **new** `dheeFork` | `branch.created` (forks from a given event/node; original untouched) |

The two new tools (`dheeSelectVersion`, `dheeFork`) are the only genuinely new
agent verbs ③ requires; everything else is the existing tool surface re-pointed
at the append API. Human actions in the UI (pick a candidate, fork a cut) append
the same events with `actor:'user'`.

## Relationship to ① and ②

- **① (content cache)** = the `generation.inputsHash` + `storeHash` in
  `node.completed`, with artifacts in the CAS. Free replay falls out of the
  determinism contract.
- **② (versions/branches)** = `version.added` / `version.selected` /
  `branch.created` events + the candidate-tray and branch-tree projections.
- ③ **subsumes** both: do ① and ② first as standalone wins; ③ is the unifying
  rewrite that turns them into projections of one log and adds time-travel +
  arbitrary UI views. If ① and ② are built event-shaped from the start, ③ is
  mostly "make the log the source of truth + write the projections," not a
  second rewrite.

## Migration / phasing

1. Land ① (cache) and ② (versions) on the current snapshot model — independent,
   shippable.
2. Introduce `EventLog.append` + the `walkState` projection. Walker emits events
   **and** writes the projected snapshot (dual-write). All existing readers keep
   working. **No reader changes yet.**
3. Add the new projections (lineage, branches, cost) + the desktop views that
   consume them.
4. (Optional) add the SQLite derived index when JSONL folding gets slow.
5. Eventually drop direct snapshot mutation; the snapshot is purely derived.

## Out of scope / open questions

- **Multi-process / multi-machine** concurrency on one log (lockfile suffices
  for single-process today; revisit for cloud).
- **Log compaction / snapshotting** for very long projects (periodic checkpoint
  events to bound replay cost).
- **Branch GC** — pruning abandoned branches and their CAS-only artifacts.
- **Schema evolution** — versioning `EventKind` payloads as the engine grows
  (an `event.schemaVersion` on the envelope, or upcasters on read).
- Whether branches are one log with `branchId` tags (recommended) vs separate
  log files per branch.

## Effort

~4–8 weeks for a solid base (steps 2–3), assuming ① and ② already landed and
were built event-shaped. The single walker choke-point + the `walkState`
back-compat projection are what keep this bounded rather than a full rewrite.
