# Project feature flags

Central registry of per-project opt-in flags. Each flag lives under
`features` in `project.json`:

```jsonc
{
  "title": "My Project",
  "features": {
    "skipHoldingBeatLF": false,
    "transitionBoundaryPlanner": false
  }
}
```

When a new project is created via `dhee_new` (the
`createProjectInProcess` runner), every flag in this registry is
seeded with its default value so the user can see what's available
without reading code. Existing projects (created before a flag
landed) don't get the field; the interpretation logic always
defaults to OFF on missing fields, so legacy projects keep their
historical behavior.

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
   `src/core/project/projectTypes.ts`** with a JSDoc explaining
   what it does, when it landed, and where it's read.
5. **Add a default-value seed in
   `src/server/runners/createProjectInProcess.ts`** so new projects
   show the flag.
6. **Read the flag via a helper** (e.g. `isXxxEnabled(project)`)
   that returns `false` on undefined / wrong-type. Don't sprinkle
   `project.features?.xxx === true` checks throughout the codebase
   — a helper centralizes the strict-equality rule.

## Registry

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

**Interaction with `transitionBoundaryPlanner`.** When both flags are
on, the skip-LF rule is additionally gated by the boundary planner's
per-shot signals. An LF that has a downstream consumer — the next
shot's `incomingTransition.operation` is `shared_frame` or
`reuse_intent` — or that's marked `needsLfAnchor: true` is
generated regardless of holding-beat status. The single source of
truth for the combined rule is `shouldSkipLastFrame` in
`shotImagePipeline.ts`. When `transitionBoundaryPlanner` is OFF, no
shot has `incomingTransition` or `needsLfAnchor`, so the combined
rule collapses to the historical skip-LF behavior.

### `transitionBoundaryPlanner`

**Default: `false`**

When true, after `scene_breakdown` produces the per-scene shot list
(description / purpose / cameraWork / dialogue / continuityRole),
a per-scene boundary-planner LLM pass classifies each shot-to-shot
boundary into one of four operations and writes the decision onto
each shot in `project.json`:

```jsonc
{
  "shotNumber": 4,
  "incomingTransition": {
    "operation": "shared_frame",
    "reason": "Shot 3 ends on Sera's datapad-lit face — exactly where shot 4 begins her reply."
  },
  "needsLfAnchor": false
}
```

Operations:

- `shared_frame` — shot N+1's `firstFrame` ImageRef is the same image
  as shot N's `lastFrame`. Generated once by N's LF call, referenced
  by both shots' frame slots. Mirrors the manual file-reuse edit the
  user did on 2026-05-22 to chain Malachor's close-up across shots
  7→8.
- `reuse_intent` — N+1's FF derives from N's LF via Klein edit; the
  FF prompt is written to closely match N's LF state with small
  intentional changes.
- `reframe` — blocking or pose broke between shots (e.g., character
  stood up); N+1's FF is generated fresh AND its prompt explicitly
  references the divergence from N's LF.
- `cut` — hard break (new location / POV / time / dialogue intent
  not continuous). Current pipeline behavior.

`needsLfAnchor: true` is a separate, per-shot signal that forces LF
generation for that shot regardless of holding-beat status — used
when a named character's expression / pose in i2v would otherwise
drift (the manual fix on 2026-05-22 shot 8).

**Read by:**
- `isTransitionBoundaryPlannerEnabled` in
  `src/core/planner/boundaryPlanner.ts` — the canonical helper that
  enforces the strict-boolean check.
- The image generation pipeline reads `incomingTransition` and
  `needsLfAnchor` off each shot when deciding whether to skip FF
  generation, share an ImageRef, or force LF generation.

**When to turn ON:**
- You've been hand-editing shot transitions to chain LFs into FFs
  and want the planner to do it up front.
- You want the LF anchor heuristic to constrain i2v drift on
  character-heavy shots without per-shot manual flagging.

**When to keep OFF:**
- New projects where you haven't yet seen poor cross-shot continuity
  in the default pipeline.
- Projects where you prefer fully independent shot generation for
  artistic reasons (e.g., montage-heavy material).
