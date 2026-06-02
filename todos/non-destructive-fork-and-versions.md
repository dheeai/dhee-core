# Non-Destructive Versioned Outputs + Fork / Select

## Problem

Today a node has exactly **one** output, and regeneration is **destructive**.
`walkState.NodeStateEntry` holds a single `outputPath`; `projectRegen.ts:144`
does `unlinkSync(abs)` then recomputes. The project can only ever represent
**one reality at a time**:

- You cannot hold two candidate outputs for the same shot — the second
  generation overwrites the first.
- Regenerating destroys the previous artifact *and its prompt provenance*; there
  is no "go back to the version I liked."
- There is no way to branch a storyline/cut and keep the original.

This blocks the entire best-of-N / taste-gate workflow and any non-destructive
creative experimentation.

## Feature

Let a node instance hold **multiple versions** with a **selected** pointer, make
regeneration **additive** (new version beside the old, never delete), and add
**fork** so a run can branch from any point while the original survives. The
existing cascade machinery (`computeCascadeImpact`) is reused to decide what
re-runs inside a fork.

## State Model Change

```typescript
// today: one entry per node, single outputPath (walkState.ts)
// proposed:
interface NodeVersion {
  versionId: string;            // nanoid
  status: NodeRunStatus;
  outputPath?: string;          // relative to projectDir (versioned path or CAS link)
  itemId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
  // provenance:
  parentVersionId?: string;     // the version this was regenerated/forked from
  inputsHash?: string;          // ties to the content-addressed cache key
}

interface NodeStateEntry {
  versions: NodeVersion[];      // all candidates, newest-last; never destroyed
  selectedVersionId: string;    // the taste-gate pick that downstream consumes
}
```

Outputs are written to **versioned paths** (or stored in the CAS and linked), so
two versions coexist on disk. Downstream nodes resolve inputs from the *selected*
version of each upstream.

## Fork Model

```typescript
interface Branch {
  branchId: string;
  label?: string;               // "noir grade", "client option B"
  parentBranchId?: string;
  forkedFromEventOrNode: string;// where it diverged
}
```

- Forking from a node copies the selected-version pointers up to that node and
  lets downstream re-run independently. The parent branch is untouched.
- With the content-addressed cache (`content-addressed-generation-cache.md`),
  the **unchanged prefix of a fork replays for free** — only divergent nodes
  recompute.

## Use Cases Unlocked (impossible today)

1. **Best-of-N you can SEE and choose from.** Generate 4 keyframes for a shot,
   view all 4, pick one — the other 3 remain available. Today the 2nd generation
   overwrites the 1st; holding two candidates is impossible. This is the core
   taste-gate / best-of-N loop.
2. **Branch the cut — two versions both alive.** "Keep the noir grade AND try a
   brighter version of the last three shots; compare the final cuts." Or hand a
   marketer three versions of a brand intro to pick from. Today: forking while
   keeping the original doesn't exist.
3. **Non-destructive undo.** Regenerate, dislike it, restore the prior version.
   Today: the prior artifact is unlinked and gone.
4. **Creative-exploration tree.** Branch, branch again, keep all leaves, compare
   directions. Today: strictly linear, single-state.
5. **(With ①) affordable best-of-N at scale** — N candidates per shot, each
   cached by inputs, pick by taste, branch winners; unselected candidates are
   neither thrown away nor re-paid for.

## Touch Points

- `src/dag/walkState.ts` — `NodeStateEntry` → `{ versions, selectedVersionId }`;
  update load/save/prune and the walker's resume/lookup (status now reads the
  selected version).
- `src/dag/projectRegen.ts` — `invalidateNodes`/`regenerateNode` stop
  `unlinkSync`; instead append a new version and (optionally) re-point selection.
- `src/dag/walker.ts` — branch-aware walk; resolve upstream inputs from selected
  versions; reuse `computeCascadeImpact` to scope a fork's re-run.
- Desktop / frontend — UI to view candidates per node and set the selected one
  (the taste gate), and to create/compare branches.
- Migration: existing single-`outputPath` entries → a one-version entry with
  that version selected (backward-compatible upgrade in `loadWalkState`).

## Non-Goals (this doc)

- The input-hash cache itself — see `content-addressed-generation-cache.md`
  (concept ①). This doc assumes it for free-prefix-replay but doesn't build it.
- Full event-sourcing (concept ③) — deferred; this is the lighter retrofit that
  delivers most of the value without rebuilding persistence.

## Open Questions

- Where do versioned artifacts live — versioned paths under the project dir vs
  CAS-only with links? (CAS-only is cleaner once ① exists.)
- Selection semantics when re-walking: does a new generation auto-select, or
  stay unselected until a human/agent picks? Default: auto-select latest, allow
  override.
- Branch storage in `project.json` vs a sidecar; pruning/garbage-collecting
  abandoned branches.

## Estimated Effort

**~2–4 weeks.** Changes the runtime state shape + walker resume/lookup +
regen + desktop selection UI. Bounded — reuses the existing DAG, the single
`walkState` choke-point, and `computeCascadeImpact`. Complements ① (do ① first;
this builds the workflow on top of it).
