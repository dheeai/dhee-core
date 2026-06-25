# Two-Bundles Build — Status & Plan

**Goal:** `narrative_shot_by_shot` and `narrative_prompt_relay`, both
full-pipeline bundles. Shot-by-shot on cloud Comfy. Prompt relay's
video stage on local Comfy. No reuse, no legacy support. Verified
end-to-end on real Comfy hardware before reporting "done."

**Status:** in progress on `feat/dag-bundles`. Multi-session work.

> **Historical note (2026-06):** the `comfy.image` runner below was later
> split into `comfy.klein` / `comfy.tti` / `comfy.fl2v` over a shared
> `comfyExecutor`.

---

## Honest reality

This deliverable cannot fit in one session. Real wall-clock
constraints:

- Each end-to-end Comfy test run is **30–60 minutes** of GPU time
  (shot-by-shot fans out per-shot FL2V renders; relay does one big
  director call per chunk).
- Multiple iterations are guaranteed — first runs will surface
  prompt issues, schema mismatches, runner config gaps.
- ~14 LLM prompts and ~5 JSON schemas need authoring or extraction.
- A new per-shot FL2V runner needs to ship.

I will commit progress at each completed piece and only report
"verified" when both bundles actually produce a final video on a
fresh project.

---

## What's DONE on this branch (commits already pushed)

- **Phase 0**: RunnerRegistry, RunnerManifest, bundle source URI
  parser (built-in:, user:, registry:), custom runner discovery via
  `~/.dhee/runners/`. 29 tests. (commit `ee23742`)
- **Phase 1**: `llm.generate` runner — universal LLM runner with
  tier routing, JSON schema validation, skip-if-output-exists,
  abort signal. 13 tests. (commit `504a1dc`)
- **Phase 2**: `comfy.image` runner — Klein-or-compatible workflow
  driver, manifest-based parameter mapping, endpoint resolution.
  11 tests. (commit `7bea38f`)
- **Phase 4**: walker enhancements — walkState persistence, stopAt,
  runOnly cascade, dep validation, event emission. 15 tests.
  (commit `7559b08`)
- **Phase 5**: `runProjectViaBundle` + executeRunTo dispatch when
  `bundleSource` is set. 6 tests. (commit `1b79c7c`)
- **Phase 6 (partial)**: deleted `runProjectInProcess` (the hybrid
  glue dispatcher). The legacy executor (`ExecutorAgent`,
  `DependencyGraphExecutor`, per-typeId handlers) remains and will
  be deleted once both bundles are verified working.
  (commit `44fedfa`)
- **Walker collection extension (Phase 7 in progress)**:
  `materializeCollection` now supports upstream-driven items
  (reading JSON arrays from an upstream node's output to spawn
  instances). Lazy materialization at run-time after the upstream
  completes. Walker now also resolves `ctx.inputs` from upstream
  outputs so LLM prompt-template substitution works.
  71 dag tests still pass. (uncommitted at the moment of this
  writing — will be in the next commit.)

End-to-end VERIFIED today:
- The Cup project (with existing upstream artifacts on disk) ran
  through `runProjectViaBundle` → walker → `comfy.ltx_director` on
  local Comfy → ffmpeg concat → 3.6 MB `dag_relay_final.mp4`. This
  proves the bundle architecture works for the relay video stage on
  a project that already has upstream content.

---

## What's STILL NEEDED (the actual work)

### 1. Walker fan-out across two-level collections

Today `materializeCollection` either (a) reads a flat JSON array from
upstream, or (b) does one-to-one with an upstream collection's
instances. Narrative needs **fan-out**: from `scenes_plan` (one stage
node whose output is `{shots: [...]}`), spawn one `shot_image_prompt`
instance per shot id. itemId = `scene_N_shot_M`.

Decision to simplify authoring: structure the bundle so
`scenes_plan` outputs a **flat** `{shots: [{id, scene, shotNumber, ...}]}`.
Walker's existing flat-array path then works without further code.

### 2. Author 14 prompt files + 5 JSON schemas

Both bundles share these. Per docs/bundle-migration-plan.md §3
Phase 3 they should be EXTRACTED from existing executor LLM call
sites where possible.

- `prompts/plot.md` — plot outline from user idea
- `prompts/story.md` — full story from plot
- `prompts/story_essence.md` — genre/tone JSON (with schema)
- `prompts/world_style.md` — visual style guide
- `prompts/characters_plan.md` — `{characters: [{id, name, description}]}` (with schema)
- `prompts/character_image.md` — Klein prompt per character (JSON or text)
- `prompts/settings_plan.md` — `{settings: [...]}` (with schema)
- `prompts/setting_image.md` — Klein prompt per setting
- `prompts/scenes_plan.md` — `{scenes: [{id, mainSubject, ...}], shots: [{id, scene, shotNumber, duration, description}]}` (with schema)
- `prompts/scene_video_prompt.md` — global director prompt per scene
- `prompts/shot_image_prompt.md` — per-shot Klein prompt (JSON, with schema)
- `prompts/shot_motion_directive.md` — per-shot motion (used by FL2V + relay)
- `prompts/shot_image_last_frame.md` — last-frame Klein prompt
- (optional) `prompts/shot_composition_guide.md` — the INLINE VISUAL HOOK rules

### 3. Bundle JSON authoring

`src/dag/bundles/narrative_prompt_relay/bundle.json`:
- 13 upstream LLM/Klein nodes (same as shot_by_shot below)
- `scene_clip` (per scene, comfy.ltx_director on local endpoint)
- `final_video` (ffmpeg.concat)

`src/dag/bundles/narrative_shot_by_shot/bundle.json`:
- 13 same upstream LLM/Klein nodes (cloud endpoint)
- `shot_video` (per shot, NEW comfy.ltx_fl2v runner on cloud endpoint)
- `final_video` (ffmpeg.concat with watermark)

### 4. New runner: `comfy.ltx_fl2v`

Per-shot Flash-to-Video using `workflows/built-in/ltx23_fl2v_api.json`
or similar cloud-compatible workflow. Takes first frame + last frame
+ motion directive → produces a shot video. Adapts the legacy
executor's per-shot video logic.

### 5. createProjectInProcess wiring

`renderMethod === 'prompt_relay'` → `bundleSource = 'built-in:narrative_prompt_relay'`
`renderMethod === 'shot_by_shot'` → `bundleSource = 'built-in:narrative_shot_by_shot'`

(Currently relay maps to `built-in:ltx_prompt_relay`, the
video-stage-only bundle. Switching to the full-pipeline bundle
happens once it's authored.)

### 6. Real end-to-end test

Two FRESH projects from `pnpm tsx scripts/run-project-via-bundle.ts`:
- "Bundle e2e — shot_by_shot" with a short story input → cloud Comfy
  → final video
- "Bundle e2e — prompt_relay" with a short story input → cloud Comfy
  for Klein + local for LTX director → final video

Each takes ~30–60 min. Iterate on failures.

### 7. Delete legacy

After both bundles verified working, delete:
- `src/core/planner/ExecutorAgent.ts`
- `src/core/planner/DependencyGraphExecutor.ts`
- `src/server/runners/runExecutor.ts`
- All per-typeId handlers
- `VALID_STAGES`, `STAGE_ALIASES`, `classifyRunTarget`
- `renderMethod` field handling (replaced by `bundleSource`)
- ProjectManager's whitelist passthroughs for renderMethod/features
  (walkState becomes the only state)
- Update all callers (ConversationManager, agentRoutes,
  backgroundTaskRunnerSingleton, agentOps, etc.)

This is significant deletion work; expect to touch ~15 files.

---

## Per-session report-back format

When each piece lands, the commit message names what's done. The
user can grep the git log on `feat/dag-bundles` for progress. I will
not say "verified" until step 6 produces a real video for both
bundles.

If a session ends mid-step, the next session picks up from the same
status doc and any uncommitted state. The goal-hook keeps firing
until the deliverable is real.

---

**Current next concrete step:** commit the walker collection
extension, then start authoring `scenes_plan.md` + its JSON schema +
`bundles/narrative_relay/bundle.json` skeleton. After that, iterate
through the remaining LLM prompts (each ~half hour of careful
extraction-and-rewrite), then the runner, then test.
