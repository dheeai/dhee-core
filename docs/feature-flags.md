# Project feature flags

Central registry of per-project opt-in flags. Each flag lives under
`features` in `project.json`:

```jsonc
{
  "title": "My Project",
  "features": {
    "skipHoldingBeatLF": false
  }
}
```

When a new project is created via `dhee_new` (the `initializeProject`
function in `src/dag/initializeProject.ts`), every flag in this
registry is seeded with its default value under `features` so the
user can see what's available without reading code. Existing projects
(created before a flag landed) don't get the field; the
interpretation logic always defaults to OFF on missing fields, so
legacy projects keep their historical behavior.

> **Note (bundle migration):** the legacy executor's feature-flag
> plumbing — `src/core/project/projectTypes.ts`, the
> `createProjectInProcess` seed, and `isSkipHoldingBeatLFEnabled` —
> was removed. The surviving reader for the bundle architecture is
> `src/dag/projectFeatures.ts`, seeded by `initializeProject.ts`. The
> `skipHoldingBeatLF` entry below is retained for historical reference
> only; its consuming code (`ExecutorAgent`, `shotImagePipeline.ts`)
> no longer exists.

## How to toggle a flag

- Hand-edit `<project>/project.json` and add/change the field under
  `features`.
- Or ask pi-agent to do it via its `edit` tool:
  *"set features.skipHoldingBeatLF to true in project.json"*
- No desktop restart needed — the executor reads the flag at the
  start of each pipeline run.

## Flag values

- All flags are **strict booleans**. The literal `true` enables;
  anything else (missing, `false`, `"true"` as a string, `1`,
  `null`) disables. This is defensive: a hand-edit typo like
  `"skipHoldingBeatLF": "true"` shouldn't silently enable an
  experimental feature.

## Conventions for new flags

1. **Default OFF.** Every new flag preserves the historical behavior
   for legacy projects. Opt-in, not opt-out.
2. **Pick a descriptive name.** Action-or-feature-noun, camelCase.
   `enableThing`, `skipThing`, `useThing` — pick whichever reads
   naturally for the default.
3. **Add to the registry in this doc** before merging.
4. **Add the field to `ProjectFeatures` in
   `src/dag/projectFeatures.ts`** with a JSDoc explaining what it
   does, when it landed, and where it's read.
5. **Add a default-value seed in `src/dag/initializeProject.ts`**
   (the `project.features` object) so new projects show the flag.
6. **Read the flag via a helper** (e.g. `isXxxEnabled(project)`) in
   `src/dag/projectFeatures.ts` that returns `false` on undefined /
   wrong-type. Don't sprinkle `project.features?.xxx === true` checks
   throughout the codebase — a helper centralizes the strict-equality
   rule.

## Registry

### `gateAfterCollections`

**Default: `true` (opt-out — the exception to the default-OFF rule above)**

This flag intentionally breaks the "default OFF" convention: it ships
**ON** so every project pauses for review after each collection by
default. The reader (`isGateAfterCollectionsEnabled`) returns `false`
ONLY for an explicit `false`; missing field / missing `features` /
non-boolean all resolve to ON. To run straight through, set
`"gateAfterCollections": false`.

Stop-after-each-collection gate. When on, a bundle walk halts as
soon as a `collection` node (other than the bundle goal) finishes a
pass in which at least one of its instances actually ran (i.e. the
runner was invoked, not a cache-skip). Downstream nodes stay pending
in walkState, so the next walk — the desktop **Resume** button,
another `dhee_run_bundle`, the CLI — cache-skips the now-complete
collection (which therefore does no new work and does not re-gate)
and proceeds to the next collection.

Net effect: **one collection step per run**, so the user can inspect
each fan-out batch (shot images, scene clips, …) before continuing.
A collection whose instances were all cache-skipped never gates, so a
resumed walk always makes forward progress.

The desktop exposes this as a toggle in the project header status row
(next to the oversight toggle); flipping it read-modify-writes
`features.gateAfterCollections` in the active project's
`project.json`. The toggle is disabled while a run is in flight — the
flag is read once at walk start, so mid-run changes wouldn't apply to
the current walk anyway.

**Read by:**
- `runProjectViaBundle` (`src/server/runners/runProjectViaBundle.ts`)
  via `isGateAfterCollectionsEnabled` (in
  `src/dag/projectFeatures.ts`); forwarded to the walker's
  `gateAfterCollections` option. The walker
  (`src/dag/walker.ts`) implements the halt + reports
  `WalkResult.gatedAfter`.

**When to turn ON:**
- Staged review of a long pipeline — you want to eyeball the shot
  images before any video renders, then the clips before assembly.

**When to keep OFF:**
- Normal unattended runs to completion.

Landed on the `feat/gate-after-collection-nodes` branch 2026-06-06.

### `skipHoldingBeatLF`

**Default: `false`**

When true, the executor strips `frames.last_frame` from
shot_image_prompt JSON for "holding-beat" shots (purpose ∈
`hold_emotion`, `show_reaction`, `show_dialogue`, `show_clue`,
`punctuate`, `set_the_mood`, `set_the_world` AND cameraWork lacks
camera-motion verbs) and flips `generationStrategy` to `i2v`. The
video provider then routes to `ltx23_i2v_*` instead of
`ltx23_fl2v_*`.

Saves one LLM call per matching shot and avoids the "mid-action"
look the LLM sometimes generates for the last frame of a static
beat. Experimental; landed on the `skip-lf` branch 2026-05-22.

**Read by:**
- `ExecutorAgent.applyHoldingBeatSkip` — the production path. Reads
  `this.config.project.features.skipHoldingBeatLF` via
  `isSkipHoldingBeatLFEnabled` (in
  `src/core/planner/shotImagePipeline.ts`).
- `generateShotImagePromptPipeline` (dead-code path in
  `shotImagePipeline.ts`) — gates on the matching
  `PipelineContext.skipHoldingBeatLFEnabled` field. Default OFF so
  the dead path is safe if it ever revives.

**When to turn ON:**
- You've validated on your project that holding-beat shots look
  better with i2v than with FL2V (which is the rationale for the
  flag).

**When to keep OFF:**
- New projects where you haven't seen the failure mode the flag was
  designed to fix.
- Projects with mostly action-y shots where the heuristic rarely
  fires anyway.
