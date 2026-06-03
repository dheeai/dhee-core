# Bug Log

Append-only ledger of observed bugs during the bundle migration and
beyond. Each entry follows the structure below. Before logging a new
bug, `grep docs/bugs.md` for similar entries AND `git log --grep` for
prior fix attempts — update the existing entry instead of duplicating.

Status values: `open` | `investigating` | `fixed` | `wont-fix`

Each `fixed` entry must point at the regression test (file path + test
name) that exercises the fix. Test pass = bug closed.

---

## Format template

```
### BUG-NNN — <one-line symptom>
- **Status:** open | investigating | fixed | wont-fix
- **Discovered:** YYYY-MM-DD
- **Reporter:** <user | claude | test>
- **Symptom:** what was observed externally
- **Evidence:** log lines, stack traces, repro commands (verbatim)
- **Suspected root cause:** best current hypothesis (mark as suspected, not confirmed)
- **Manifestations to test:** brainstorm all surfaces, not just the observed one
- **Test:** path to regression test (if fixed)
- **Fix commit:** SHA (if fixed)
```

---

(No bugs logged yet for the bundle migration. The hybrid-era bugs that
prompted the migration are documented in the commit history of the
`feat/dag-bundles` branch, not here.)

---

### BUG-001 — `ltx23_director_chain_local.json` workflow fails on VHS_LoadVideo node 200 (no input video supplied)
- **Status:** fixed
- **Discovered:** 2026-05-27
- **Reporter:** claude (during Phase 3 end-to-end smoke test on The Cup)
- **Symptom:** Bundle dispatch succeeds, Comfy accepts the prompt, but the run terminates in ~18s with `comfy.ltx_director: no video output from Comfy`. No video file is produced.
- **Evidence:**
  - Comfy prompt id: `fe5b3244-3bab-439d-9e13-bfafbbd6dc47`
  - Comfy `/history/` reports `status: error`
  - Failing node: `200` (`VHS_LoadVideo`)
  - Exception: `C:\Users\Ganaraj\Downloads\ComfyUI-Easy-Install\ComfyUI-Easy-Install\ComfyUI-Easy-Install\ComfyUI\input\ could not be loaded with cv.` — VHS_LoadVideo received the *input directory path* as its filename, meaning the workflow's `video` input field was empty/null.
  - Successfully executed nodes before the failure: 81, 80, 77, 4, 46, 84, 3 — these include the LTX Director (46) so global_prompt and timeline_data got applied. The failure is downstream of director output, plausibly a passthrough node.
- **Suspected root cause:** The `ltx23_director_chain_local.json` workflow has a `VHS_LoadVideo` node (id 200) intended for video-to-video chaining (continuation across chunks). It's expected to be optional — receive an empty path when there's no prior chunk to continue from. Either:
  - (a) The workflow's VHS_LoadVideo isn't actually optional (no default), and the runner needs to either bypass the node or set a fallback video path for first-chunk runs.
  - (b) The runner needs to special-case the first chunk (no prior video) vs continuation chunks (load prior chunk's output).
  - (c) The chain workflow was authored for a multi-chunk scenario and isn't compatible with the single-chunk path (The Cup is 7 shots in one chunk).
- **Manifestations to test:**
  - First-chunk single-scene single-chunk run (this case) — fails.
  - Multi-chunk run where chunk 2+ supplies a prior video — might work if (b) is the cause.
  - Single-chunk run with the *non-chain* variant `ltx23_director_local.json` — likely works (was the original bundle target before commit 25b7edf switched to the chain workflow).
  - The `scripts/probe-ltx-director.ts` / `scripts/probe-ltx-director-chain.ts` probes — should be re-run to confirm the chain workflow worked at all in the probe.
- **Test:** `tests/dag/bundle-paths.test.ts` — "BUG-001 regression — bundle points at the non-chain director workflow (first-chunk safe)". Pins both the workflowPath choice AND independently asserts the on-disk workflow contains zero VHS_LoadVideo nodes (so a future workflow-file edit can't reintroduce the dependency without failing the test).
- **Fix commit:** the bundle's `scene_clip.runner.config.workflowPath` reverted from `ltx23_director_chain_local.json` back to `ltx23_director_local.json`. The chain workflow is reserved for future per-instance multi-chunk continuation work (manifestation (b) above); BUG-001 (b) and (c) remain as known follow-up but the canonical single-chunk case is verified working end-to-end on The Cup (assets/videos/final/dag_relay_final.mp4, 3.6 MB).

---

### BUG-002 — Walker collection materializer picks the wrong array when upstream JSON has multiple
- **Status:** fixed
- **Discovered:** 2026-05-27 (live during narrative_prompt_relay smoke on /tmp/bundle-e2e-smoke)
- **Reporter:** claude
- **Symptom:** `scenes_plan` LLM output is `{scenes: [...], shots: [...]}`. Both shot_image_prompt and scene_clip were sourced from scenes_plan, but only ONE instance of shot_image_prompt was created (with itemId='scene_1'), not one per shot. The materializer was picking the first array property (`scenes`, length 1) instead of `shots` (length 6).
- **Evidence:** "shot_image_prompt[scene_1] via llm.generate" appeared once instead of 6 times in run output.
- **Suspected root cause:** materializer used `Object.values(obj).find(Array.isArray)` which is order-dependent and ambiguous when multiple arrays exist.
- **Manifestations to test:** (a) upstream emits a single array — pick it (works today); (b) upstream emits two arrays, bundle specifies itemKey — pick the named one; (c) upstream emits two arrays, bundle does NOT specify itemKey — fall back to first array property (back-compat); (d) itemKey names a property that isn't an array — should fail clearly, not silently fall through.
- **Test:** `tests/dag/walkerCollectionItemKey.test.ts` (added with this fix).
- **Fix commit:** NodeDef gains `itemKey?: string`. Walker materializer checks `obj[itemKey]` first when set. Bundle declares `itemKey: 'shots'` on shot-fanout nodes, `itemKey: 'scenes'` on scene_clip, etc.

### BUG-003 — Walker did not inject ctx.itemId as a template variable
- **Status:** fixed
- **Discovered:** 2026-05-27 (during the same smoke run)
- **Reporter:** claude
- **Symptom:** Prompts that needed to know which shot they were operating on couldn't access the item id. The shot_image_prompt template was originally written with `{{shot_breakdown}}` (intended to be per-shot data); when re-pointed at `{{scenes_plan}}` (the whole JSON), it also needed `{{item_id}}` so the LLM could locate "the shot I'm working on" in the full scenes array.
- **Evidence:** "prompt template references variable(s) that were not provided: shot_breakdown" — the prompt was looking for a key that didn't exist; once renamed, the prompt also needs ctx.itemId.
- **Suspected root cause:** llm.generate runner's template substitution only fed `ctx.inputs`; ctx.itemId was not auto-injected.
- **Manifestations to test:** (a) item_id is exposed as {{item_id}} for collection instances; (b) item_id is not over-written when an upstream input is also keyed "item_id" (precedence); (c) stage nodes (no itemId) — {{item_id}} reference fails clearly with the "not provided" error.
- **Test:** `tests/dag/runners/llmGenerate.test.ts` — new case "exposes ctx.itemId as {{item_id}} for collection instances".
- **Fix commit:** llmGenerate runner now seeds `inputsWithItemId = { ...ctx.inputs, item_id: ctx.itemId }` before substitution.

### BUG-004 — Walker bundle-input file loader could not consume `inputs/story.md` style root paths
- **Status:** fixed
- **Discovered:** 2026-05-27 (during the same smoke run)
- **Reporter:** claude
- **Symptom:** When a fresh bundle project was set up with `inputs/story.md` and bundle.json declared `{kind:'file', path:'inputs/story.md'}`, the prompt successfully received {{story_input}}. Originally the walker had no concept of bundle-level inputs and could not have consumed file content this way.
- **Suspected root cause:** missing feature — bundles must be able to declare "root inputs" coming from project files / project.json fields.
- **Manifestations to test:** (a) file kind with present file → resolved as string; (b) file kind with missing file + required=false → silently absent; (c) file kind with missing file + required=true → error names the file; (d) project kind with present field via dot-path → resolved; (e) project kind with missing field + default → uses default; (f) project kind with missing field + no default + required → error names the field.
- **Test:** `tests/dag/walkerBundleInputs.test.ts` (added with this fix).
- **Fix commit:** walker.ts gains `resolveBundleInputs()`; schema gains `BundleInputDecl[]`.

### BUG-005 — Walker stopAt didn't restrict to ancestors; processed independent topo branches
- **Status:** fixed
- **Discovered:** 2026-05-27 (live during narrative_prompt_relay smoke; `--stopAt character_image_prompt` tried to also run scene_clip because both are ancestors of final_video and scene_clip happened to appear earlier in the linear topo)
- **Reporter:** claude
- **Symptom:** `pnpm tsx scripts/run-project-via-bundle.ts <dir> --stopAt character_image_prompt` errored with "comfy.ltx_director: instance missing sceneNumber/shotRange" — i.e. the walker attempted to run scene_clip even though the user asked to halt at character_image_prompt.
- **Suspected root cause:** stopAt was implemented as "break after the target node runs," which is correct only when the linear topo order matches the user's intent. Independent topo branches (character_image_prompt and scene_clip both descend from final_video but neither is ancestor of the other) can appear in any order; the walker happily processes the wrong one.
- **Manifestations to test:** (a) stopAt at a node X — only ancestors of X (transitively, including X itself) run; (b) two independent branches — running one with stopAt does not touch the other; (c) stopAt at the goal — equivalent to no stopAt (everything ancestral to the goal runs); (d) stopAt at a node with no ancestors (root) — only that node runs.
- **Test:** `tests/dag/walkerStopAtAncestors.test.ts` (added with this fix).
- **Fix commit:** walker computes the ancestor set of stopAt via reverse-DFS through bundle.inputs and filters the linear topo to that set.

### BUG-006 — scene_clip instance materialized from scenes_plan was missing sceneNumber
- **Status:** fixed
- **Discovered:** 2026-05-27 (live, same run; surfaced after BUG-005's stopAt fix narrowed scope)
- **Reporter:** claude
- **Symptom:** scene_clip materialized with itemId='scene_1' but no sceneNumber on the instance. buildRunnerConfig's comfy.ltx_director branch threw "instance missing sceneNumber/shotRange" trying to call resolveRelayInputs.
- **Suspected root cause:** the new upstream-driven materializer (BUG-002 fix) didn't extract scene metadata from item ids — it only set itemId. The legacy 'scene' itemSource path DID set sceneNumber because it took numbers from cli.sceneIds.
- **Manifestations to test:** (a) item id like 'scene_3' → sceneNumber=3; (b) item id like 'scene_3_shot_2' → sceneNumber=3 (parsed from prefix); (c) item id with no scene prefix → sceneNumber undefined (won't cause an error unless a runner consumes it; runners that need it should error clearly).
- **Test:** `tests/dag/walkerSceneNumberDerive.test.ts` (added with this fix).
- **Fix commit:** materializer regex `^scene_(\d+)` on itemId to derive sceneNumber when present.

### BUG-011 — scenes_plan total duration falls short of targetDuration (148s vs 180s)
- **Status:** open
- **Discovered:** 2026-05-27 (SLOP project run 3)
- **Reporter:** user
- **Symptom:** scenes_plan prompt says "sum of all shot durations == {{targetDuration}}". For SLOP at targetDuration=180, the LLM produced 34 shots summing to 148s — 32s short. Final video runs shorter than user-requested duration.
- **Evidence:** plans/scenes_plan.json shows 34 shots, sum(duration)=148, vs project.targetDuration=180.
- **Suspected root cause:** the "Hard rules: sum must equal" instruction is a soft instruction that LLMs (DeepSeek V4 Flash here) routinely violate. Without an arithmetic check at LLM time or a walker-side enforcement (pad shortest shots, or reject and retry with an error pointing at the gap), the constraint isn't enforced.
- **Manifestations to test:** (a) sum equals target → accept; (b) sum < target by N seconds → walker pads N seconds distributed across shots OR rejects with "needs X more seconds" feedback for retry; (c) sum > target → walker shrinks proportionally OR rejects; (d) targets the model can't physically meet at 3-6s/shot get auto-extended to the nearest feasible value.
- **Test:** (none yet — needs regression test before fix)
- **Fix commit:** (none)

### BUG-012 — scenes_plan doesn't split a recurring scene around a cutaway insert
- **Status:** open
- **Discovered:** 2026-05-27 (SLOP project run 3)
- **Reporter:** user
- **Symptom:** Story has setting A → B → A → C pattern (interview room → Carla's cubicle cutaway → back to interview room → montage). LLM emitted scene_1=room (entire interview, 28 shots), scene_2=cubicle (1 shot), scene_3=montage. The "back to A" section got lumped into scene_1 instead of being split out, so when ffmpeg.concat stitches in scene order, the cubicle cutaway plays AFTER the entire interview, not interleaved into the middle where the story places it.
- **Evidence:** plans/scenes_plan.json — scene_1 ends with "Unfortunately, the next stage is also me. It's a journey." (the climax). scene_2 is the cubicle cutaway. The cubicle cut in the source story happens DURING Marcus's "is there a human reviewing any of this" exchange, mid-interview.
- **Suspected root cause:** prompt says "every time the camera cuts to a different location/setting, start a new scene" but doesn't explicitly cover the A→B→A case — i.e. the LLM grouped all A shots into one scene regardless of when they occur chronologically.
- **Manifestations to test:** (a) A→B→A → three scenes (s1=A, s2=B, s3=A reusing settingId), chronological; (b) A→B→A→B→A → five scenes; (c) brief insert (1 shot at B) returning to A vs proper scene break — should still split; (d) the closing montage as a final scene is fine.
- **Test:** (none yet)
- **Fix commit:** (none) — tighten the scenes_plan.md prompt to explicitly require chronological ordering and prohibit grouping non-contiguous same-setting shots into one scene.

### BUG-013 — narrative_prompt_relay generates unused last-frame images (wasted cloud spend)
- **Status:** open
- **Discovered:** 2026-05-27 (SLOP project run 3)
- **Reporter:** user (questioning why last frames are generated)
- **Symptom:** narrative_prompt_relay bundle declares shot_image_last_frame_prompt + shot_image_last_frame nodes that produce one prompt + one cloud Comfy image per shot. For SLOP that's 34 prompt LLM calls and 34 cloud Klein renders that are never consumed. Adds ~$0.50 + ~15min per run.
- **Evidence:** src/dag/runners/comfyLtxDirector.ts — ShotInput interface has no lastFrame field, runner only consumes firstFrames. Walker (walker.ts comfy.ltx_director branch) only sets `firstFrames` in runner config. shot_image_last_frame output is declared in bundle.json scene_clip.inputs but never read.
- **Suspected root cause:** copy-paste from narrative_shot_by_shot bundle (where each shot uses LTX FL2V needing first + last anchors). Director relay path doesn't need them.
- **Manifestations to test:** (a) prompt_relay bundle runs without shot_image_last_frame_* nodes and still produces valid final video — confirms not load-bearing; (b) shot_by_shot bundle keeps them — confirms still needed there.
- **Test:** (none yet) — add e2e test that prompt_relay walks to completion with last_frame nodes removed.
- **Fix commit:** (pending) — remove shot_image_last_frame_prompt + shot_image_last_frame from narrative_prompt_relay/bundle.json, remove their input declarations from scene_clip.inputs.

### BUG-014 — Walker chunkBy not applied to upstream-driven collection materialization
- **Status:** investigating
- **Discovered:** 2026-05-27 (SLOP project run 4)
- **Reporter:** user (LTX 1000-frame cap exceeded at scene_clip)
- **Symptom:** scene_clip declared `chunkBy: {constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true}` and `itemKey: 'scenes'`. For scene_1 with 28 shots totaling 2929 frames (>1000), the walker still materialized scene_1 as ONE instance, and the LTX director runner threw "total frames 2929 exceeds LTX 2.3 audio-latent cap (1000)".
- **Evidence:** /tmp/slop-run4.log — "✗ scene_clip[scene_1]: comfy.ltx_director: total frames 2929 exceeds LTX 2.3 audio-latent cap (1000)".
- **Suspected root cause:** Walker materializeCollection has chunkBy handling ONLY in the legacy 'itemSource: scene' branch (line 169). The upstream-driven branch (`itemSource: <upstreamNodeId>`) ignores chunkBy entirely.
- **Manifestations to test:** (a) upstream scenes_plan + chunkBy declared + scene total < cap → one chunk per scene (chunkIndex=1, chunkCount=1, full shotRange); (b) upstream scenes_plan + chunkBy + scene total > cap → multiple chunks with disjoint shotRanges covering all shots; (c) no chunkBy → single instance per scene (back-compat); (d) chunkBy declared but itemKey != 'scenes' → no chunking attempted (chunkBy is scene-specific).
- **Test:** tests/dag/walkerChunkByUpstream.test.ts (to be added with fix).
- **Fix commit:** (pending)

### BUG-015 — ffmpeg.concat subtitles filter chokes on paths with special chars
- **Status:** fixed
- **Discovered:** 2026-05-27 (SLOP run 5 final_video)
- **Reporter:** user
- **Symptom:** ffmpeg.concat re-encode pass failed with `[AVFilterGraph] Error parsing filterchain '[0:v]subtitles='...Everything\'s SLOP...'[withsubs]'`. ffmpeg's filter-graph parser doesn't handle escaped single quotes inside a single-quoted argument.
- **Suspected root cause:** Filter arguments are parsed by ffmpeg's filter graph, not by the shell. Even with proper escaping, paths containing apostrophes/spaces/colons confuse the parser.
- **Fix:** Stage the SRT to /tmp/dag_subs_<hex>.srt (no special chars), reference that in the filter, unlink after the ffmpeg call.
- **Test:** (not added yet) — should add a test that runs ffmpeg.concat with a projectDir whose path contains spaces+apostrophes.
- **Fix commit:** src/dag/runners/ffmpegConcat.ts — stageSrtForFilter helper.

### BUG-016 — Desktop loads dead `dhee-core/manager` barrel; whole IPC bridge fails to register
- **Status:** stop-gap committed; architectural fix pending
- **Discovered:** 2026-05-28 (Ruby V4 — empty Prompts tab + missing thumbnail)
- **Reporter:** user
- **Repo:** kshana-desktop ↔ kshana-core
- **Symptom:** Desktop boots fine but every `dhee:*` IPC channel is unregistered. Renderer calls like `window.dhee.resolveBundle(...)` reject with `Error: No handler registered for 'dhee:resolveBundle'`. Knock-on effects: Prompts/Storyboard/Assets panels stay empty for bundle-era projects; landing tile shows no thumbnail/stats; chat panel can't dispatch.
- **Evidence:** `/Users/ganaraj/Library/Logs/dhee-desktop/main.log` — `[dheeCoreManager] Package export import failed: Cannot find module '.../dhee-core/dist/server/manager.js'` followed by `Failed to start embedded engine: Cannot find module '.../dhee-core/dist/server/manager.js'`. `registerdheeIpcBridge` is gated on a successful `dheeCoreManager.start()` so the bridge never registers.
- **Root cause:** Commit `d6f11bd` ("full legacy deletion — bundle architecture only") removed `src/server/manager.ts` (and the whole `ConversationManager` + pi-coding-agent stack) but left the `./manager` entry in `kshana-core` `package.json` `exports`. `tsup.config.ts` only builds 4 entries; the leftover `dist/server/manager.js` from a pre-deletion build was wiped on the next `pnpm tsup` (`clean: true`), making the missing-source visible. The desktop's `dheeCoreManager.ts` does an ESM `import('dhee-core/manager')` at startup to construct a `ConversationManager` it only uses for `.shutdown()`.
- **Manifestations to test:**
  - (a) Fresh `pnpm tsup` in kshana-core produces a working `dist/` that the desktop can import without a missing-module error.
  - (b) The desktop registers all `dhee:*` IPC channels even when no ConversationManager-style chat backend exists.
  - (c) A test renderer calling `window.dhee.resolveBundle(...)` against the running app returns `{ ok: true, bundle: {...} }` for `built-in:narrative_qwen_chain_relay`.
  - (d) Restarting the desktop with `dhee-core/manager` deleted entirely (the proper end-state) still boots.
- **Stop-gap (committed):** added a thin `src/server/manager.ts` exporting a no-op `ConversationManager` + the live analytics/loadDevEnv helpers; added `server/manager` to `tsup.config.ts` entries. Lets the desktop boot today.
- **Proper fix:** split the desktop's `dheeCoreManager` into (i) an "engine" lifecycle that only initializes the bundle dispatcher + analytics + workflow registry (no `ConversationManager`), and (ii) remove the `./manager` export from `package.json`. Delete `dheeCoreManager`'s `cm` field, `shutdown()` call, all `dhee:runTask` / `dhee:cancelTask` / `dhee:redoNode` IPC channels that route through the dead facade.
- **Tests to add:** `tests/main/dheeCoreManager.startsWithoutConversationManager.test.ts` (Red: assert `start()` resolves without importing `dhee-core/manager`); `tests/main/ipcBridge.registersDhee.test.ts` (Red: assert all `dhee:*` channels registered after `start()`).
- **Fix commit:** stop-gap — `src/server/manager.ts`, `tsup.config.ts`; proper fix — pending.

### BUG-017 — `backendProjectToDesktopManifest` crashes on bundle-era project.json (missing `updatedAt`)
- **Status:** stop-gap committed; architectural fix pending
- **Discovered:** 2026-05-28 (Ruby V4 — Prompts/thumbnail empty after BUG-016 unblocked)
- **Reporter:** user
- **Repo:** kshana-desktop
- **Symptom:** With the IPC bridge registered (BUG-016 stop-gap), opening a bundle-era project surfaced `[ProjectContext] Failed to load project: Invalid time value`. ProjectContext set `error` and never wrote `isLoaded: true`, so every preview panel rendered the empty/loading state.
- **Evidence:** `/Users/ganaraj/Library/Logs/dhee-desktop/main.log` — `[RendererConsole:error] [ProjectContext] Failed to load project: Invalid time value`. Trace: `backendProjectAdapter.ts:509` — `manifest.updated_at = new Date(project.updatedAt).toISOString();`. Ruby V4's `project.json` has `createdAt` as an ISO string and no `updatedAt`; `new Date(undefined).toISOString()` throws `RangeError: Invalid time value`.
- **Root cause:** `BackendProjectFile` (kshana-desktop `src/renderer/services/project/backendProjectAdapter.ts:73`) is the legacy executor-era v2.0 schema (`version`, `phases`, `content`, `characters[]`, `settings[]`, `scenes[]`, `assets[]`, numeric `createdAt`/`updatedAt`). A bundle-era `project.json` is a different shape entirely — `{ id, name, createdAt, templateId, style, bundleSource, walkState }` — with no `updatedAt` and ISO-string `createdAt`. The adapter chain (`backendProjectToDesktopManifest`, `backendProjectToDesktopAgentState`, `desktopAgentStateToBackendProject`) is dead code for bundle projects but still on the load path.
- **Manifestations to test:**
  - (a) Bundle project with no `updatedAt`, ISO `createdAt` loads cleanly.
  - (b) Bundle project with `createdAt` missing entirely loads cleanly (falls back to now).
  - (c) Legacy executor project (numeric `createdAt`/`updatedAt`) still loads.
  - (d) Project file with malformed `createdAt` ("not a date") doesn't crash; falls back gracefully.
- **Stop-gap (committed):** `safeIsoDate` helper in `backendProjectAdapter.ts:512`; `updated_at` falls back to `created_at` which falls back to `Date.now()`.
- **Proper fix:** delete `BackendProjectFile` for the bundle codepath entirely. `ProjectService.openProject` should detect `bundleSource` in `project.json` and return a `BundleProject` shape directly; renderer code consumes `walkState` via `bundleCapability` helpers, never an adapted v2.0 manifest. Adapter remains only for any genuinely legacy executor projects still on disk (or is deleted if there are none).
- **Tests to add:** `src/renderer/services/project/backendProjectAdapter.test.ts` (Red: feed bundle-shape JSON missing `updatedAt`; assert no throw, `updated_at === created_at`); `src/renderer/services/project/ProjectService.bundle.test.ts` (Red: `openProject` on a bundle dir returns `{success:true}` without touching the adapter).
- **Fix commit:** stop-gap — `src/renderer/services/project/backendProjectAdapter.ts`; proper fix — pending.

### BUG-018 — `PromptsView` mixes capability API with hardcoded `shot_image_prompt:` node-id regex
- **Status:** won't fix — component being deleted as part of BUG-020 (Inspector Canvas replaces PromptsView entirely)
- **Discovered:** 2026-05-28 (Ruby V4 — Prompts tab populates only because qwen bundle happens to use the same node names as narrative_prompt_relay)
- **Reporter:** AI (during BUG-016/017 debugging)
- **Repo:** kshana-desktop
- **Symptom:** PromptsView correctly resolves the bundle and queries `shot.prompt` / `shot.motion` via the capability API to build the work list — but the `completedShots` / `completedMotion` sets that gate the render loop are built by regex-matching node ids: `id.match(/^shot_image_prompt:(scene_\d+_shot_\d+)$/)` and `id.match(/^shot_motion_directive:(scene_\d+_shot_\d+)$/)`. Any bundle whose internal node names differ from those literals will render zero shots even when capability tags + walkState are correct. Violates the contract from `docs/display-capabilities.md` ("bundles can name nodes anything").
- **Evidence:** `src/renderer/components/preview/PromptsView/PromptsView.tsx:694,701` — the regex match runs against raw `walkState.nodes` keys; nothing reads the bundle's `displayCapability` tags.
- **Manifestations to test:**
  - (a) Bundle that names the prompt node `shot_prompt` (no `_image_`) still renders shots in the Prompts tab.
  - (b) Bundle that names the prompt node `image_prompt` (different ordering) still renders.
  - (c) Bundle with no `shot.motion`-tagged node at all renders shots without motion blocks (doesn't 0-out the panel).
  - (d) An invalidated capability instance (status: invalidated) is filtered out.
- **Suspected root cause:** Half-finished migration to the capability API. The work-list now uses capability lookup, but the completion-gating sets were never migrated.
- **Tests to add:** `src/renderer/components/preview/PromptsView/PromptsView.capability.test.tsx` (Red: render with a `shot_prompt`-named bundle, assert one tile per completed shot regardless of node id).
- **Fix commit:** (pending) — replace `completedShots`/`completedMotion` regex derivation with `listCompletedItemIds(bundle, project, 'shot.prompt')` / `'shot.motion'`.

### BUG-019 — PromptsView assumes a single prompt JSON schema (`frames.first_frame.imagePrompt`); other bundles render empty
- **Status:** superseded by BUG-020 — the desktop's tab-per-artifact-shape architecture is the root issue, not this one schema mismatch. Inspector Canvas (BUG-020) renders artifacts by declared node `kind` + `headlineField` and obsoletes PromptsView entirely.
- **Discovered:** 2026-05-28 (Ruby V4, after BUG-016+BUG-017 stop-gaps unblocked the load path)
- **Reporter:** AI (diagnosed by inspecting the on-disk prompt JSON vs the component's interface)
- **Repo:** kshana-desktop
- **Symptom:** Prompts tab is empty for `narrative_qwen_chain_relay` projects even though `walkState` has 31 completed `shot_image_prompt:scene_N_shot_M` instances and the JSON files exist on disk and parse fine.
- **Evidence:**
  - On-disk schema (`prompts/shot_image/scene_1_shot_1.json` in Ruby V4): `{ "chosenBaseShotNumber": null, "chosenBaseReason": "...", "view": "front-left quarter view", "elevation": "eye-level shot", "distance": "wide shot", "deltaText": "..." }`.
  - `src/renderer/components/preview/PromptsView/PromptsView.tsx:69-79` — `ShotPromptFile` interface expects `{ shotNumber, frames: { first_frame: { imagePrompt, ... }, last_frame, mid_frame }, negativePrompt, aspectRatio }`.
  - `:1119` — `const ff = entry.prompts?.frames?.first_frame;` and `:1177` — `text={ff?.imagePrompt}`. With the qwen-chain bundle's flat schema, every `ff` is `undefined` and every text block renders empty. The number of tiles may even be zero depending on render gates.
- **Root cause:** Every bundle produces its own prompt schema (prompt_relay → multi-frame, shot_by_shot → first+last, qwen_chain_relay → flat delta), but the desktop component hardcodes one schema. This violates the bundle ↔ desktop contract — the desktop should not assume what a bundle's prompt looks like.
- **Manifestations to test:**
  - (a) `narrative_qwen_chain_relay` project renders 31 tiles in Prompts tab with `deltaText` visible.
  - (b) `narrative_shot_by_shot` project still renders first + last frame blocks per shot.
  - (c) `narrative_prompt_relay` project still renders single-frame blocks per shot.
  - (d) A future bundle producing `{ description, mood, lighting }` renders something readable without code changes (e.g. generic key/value display).
- **Suspected architectural fix:**
  - Add a `display.shot_prompt_fields` block to `bundle.json` declaring which JSON fields make up the "headline" / "details" of a shot prompt — e.g. `{ headline: "deltaText", details: ["view", "elevation", "distance"] }`.
  - PromptsView reads that mapping from the resolved `BundleSnapshot.display` and renders accordingly. Falls back to a generic key/value table when nothing is declared.
  - Delete `ShotPromptFile` / `FrameData` interfaces from the component.
- **Tests to add:**
  - `PromptsView.qwen_chain_schema.test.tsx` (Red: render with qwen-chain fixture project, assert 31 tiles + `deltaText` text node present).
  - `PromptsView.prompt_relay_schema.test.tsx` (Red: assert per-frame blocks present for narrative_prompt_relay).
  - `PromptsView.unknown_schema_graceful.test.tsx` (Red: bundle without `display.shot_prompt_fields`, prompt JSON has only `description` — assert generic key/value renders).
- **Fix commit:** (pending).

### BUG-020 — Project workspace must render the bundle DAG itself, not a fixed set of artifact-shape tabs
- **Status:** open — Inspector Canvas implementation in progress (feat/dag-bundles)
- **Discovered:** 2026-05-28 (after BUG-019 surfaced the per-tab schema-mismatch problem; user pushed to a deeper framing)
- **Reporter:** user
- **Repo:** kshana-desktop + kshana-core
- **Symptom (framing, not a runtime bug):** The desktop workspace today is Prompts / Storyboard / Assets / Timeline / Video Library — each tab is a hardcoded reader for one specific subdirectory and one specific JSON schema. Every new bundle shape (qwen-chain's flat prompt schema, a future music bundle, a 3D bundle, anything) requires per-tab code. The bundle architecture made tabs obsolete; we hadn't realized it yet.
- **Root architectural cause:** Three of the five tabs (Prompts, Storyboard, Assets) are all views over the same underlying graph — they just slice it by artifact directory. The honest view is the graph itself: nodes as cards, edges as drawn lines, per-item rails for collections. Per-node `kind` + `headlineField` lets the desktop render any artifact without bundle-specific code.
- **Decision:** Replace Prompts + Storyboard + Assets tabs with a single **Inspector Canvas** view — pan/zoomable HTML+SVG canvas rendering the bundle DAG. Each card renders the artifact at its `outputPath` per the node's declared `kind` (image / text / md / json / video / audio). Collection nodes render as RAILS containing per-`item_id` tiles. Timeline tab stays separate (it's a sequencing UI, not an inspection one). Video Library stays for now.
- **Constraints (per project memory):**
  - Agent stays primary. Canvas is a *view*, not the only surface — the agent panel is always visible and onboarding leads with the agent.
  - Default view is **outputs**, not the DAG — the canvas surfaces outputs prominently; upstream stage cards can be collapsed.
  - Direct manipulation is allowed for targeted edits (regenerate a node, swap a runner, tweak a param) but the canvas is not a freeform graph editor.
- **Schema additions (kshana-core):**
  - `NodeDef.kind`: required, one of `image | text | md | json | video | audio` (with `text` covering plain string output, `md` for markdown).
  - `NodeDef.headlineField`: optional, dot-path into the node's JSON output that names the headline field shown on the card (e.g. `deltaText` for qwen-chain shot prompts, `frames.first_frame.imagePrompt` for prompt-relay).
  - All 3 built-in bundles tagged with kinds.
- **Mockup:** `docs/mockups/inspector-canvas-v1.html` (reference design — palette, density, kind renderers).
- **Manifestations to test:**
  - (a) Bundle schema validates `kind` enum; unknown kind rejected with a clear error.
  - (b) `headlineField` is optional; absent → tile shows the raw first scalar value or a generic key/value table.
  - (c) `bundleToFlowGraph(bundle, walkState)` emits one React-Flow node per stage + one parent rail node per collection, with correct edges from `inputs[].from`.
  - (d) `ImageNode` renders an `<img src>` pointing at `outputPath` (via Electron file protocol).
  - (e) `JsonNode` renders the field at `headlineField` when present; falls back to a generic tree view otherwise.
  - (f) `VideoNode` renders a poster frame from the artifact and a play overlay; clicking plays inline (or opens Timeline for `final_video`).
  - (g) `AudioNode` renders an HTML5 `<audio>` element with custom transport.
  - (h) `CollectionRail` virtualizes when item count > 12 (don't render 31 tiles inert).
  - (i) Status overlays (running pulse, failed red border, invalidated stripe) reflect walkState in real time when project.json changes on disk.
  - (j) Right-click "regenerate" on a tile dispatches `redoNode(nodeId, itemId)` via existing IPC (no IPC contract change).
- **Tests to add (phased):**
  - Phase 1 (kshana-core):
    - `src/dag/schema.test.ts` — `NodeDef.kind` validation, all 3 built-in bundles parse cleanly with kinds tagged
    - `src/dag/capabilities.test.ts` — capability instances surface `kind` from the bundle
  - Phase 2 (kshana-desktop):
    - `src/renderer/inspector/bundleToFlowGraph.test.ts` — pure transform
    - `src/renderer/inspector/nodes/JsonNode.test.tsx` — headlineField rendering
    - `src/renderer/inspector/nodes/ImageNode.test.tsx`, `VideoNode.test.tsx`, `AudioNode.test.tsx`, `CollectionRail.test.tsx`
    - `src/renderer/inspector/InspectorCanvas.integration.test.tsx` — full mount with qwen-chain fixture
  - Phase 3 (cleanup):
    - delete `PromptsView`, `StoryboardView`, `AssetsView` + their tests
    - delete `BackendProjectFile` adapter for bundle path (BUG-017 proper fix)
    - delete dheeCoreManager's ConversationManager facade (BUG-016 proper fix)
- **Scope estimate:** 4–6 Claude-Code days for v1 (inspection only, no editing); +2–3 days for regenerate/status overlays; +2–3 days for Timeline modal integration. Each phase ships incrementally on `feat/dag-bundles`.
- **Fix commit:** (pending).

---

### BUG-025 — `vlm.judge` runner does too many things; violates single-purpose rule
- **Status:** open — tech debt; functionally correct, architecturally wrong
- **Discovered:** 2026-05-30
- **Reporter:** ganaraj (memory `feedback-runner-isolation` reinforcement)
- **Symptom:** `src/dag/runners/vlmJudge.ts:run()` does FIVE distinct verbs inside one runner:
  1. Read image from canonical path
  2. Stash current image to `.attempts/{item}_attempt_N.png`
  3. Call VLM (mimo) and parse verdict
  4. Pick best-of-N across all stashed attempts
  5. Copy best-attempt stash back over the canonical path
  6. Stamp `pendingCritiques[refineNode:itemId]` in project.json on fail
  - Per the memory: *"A runner that does a refinement pass with VLM + prompt edit + Qwen is wrong. That's doing 3 things. The 3 things should be done in the graph. Not inside a runner."* The judge runner has the same shape — verdict + stash + best-of-N selection + canonical-path mutation + walkState side-effect, all in one `run()`.
- **Suspected root cause:** I conflated "the judge node" with "everything that supports best-of-N across iterations". Stashing, selection, and pendingCritique stamping are walker-loop concerns, not judge concerns. The judge should produce ONE verdict per call and nothing else.
- **Manifestations / what to test:**
  - Bundle author cannot swap in a different VLM provider without inheriting the stash + restore + select code.
  - Cannot reuse the stash/select logic with a different judge (e.g. multi-judge ensemble) — it's locked inside one file.
  - Restoration writes outside the runner's own outputPath — violates the runner-output invariant.
- **Proper fix (deferred):** Split into three concerns:
  1. **`vlm.judge` runner** — pure: read image + context, call VLM, write verdict JSON to outputPath. Nothing else.
  2. **Walker review-loop** — own the per-iteration stash (snapshot image to `.attempts/`) and the best-of-N selection (compare verdicts after each walk, restore best to canonical path).
  3. **Walker pendingCritique stamping** — already mostly walker territory; move the final stamp out of the judge runner into the walker's post-judge step (driven by the verdict JSON the runner just wrote).
  - Bundle stays exactly the same shape (one review node per upstream); the loop infrastructure absorbs the now-extracted concerns.
- **Workaround in the meantime:** the current implementation IS functionally correct — the experiment we just ran (17-shot batch refinement) used the right test transport (the dedicated scripts `refineImageViaQwen` / `refineImageViaKlein`, NOT the vlm.judge runner). So nothing in production depends on the conflated runner yet — only the smoke tests.
- **Test:** pending — write a test that asserts judge runner output is verdict-only (no file mutation beyond outputPath, no project.json writes) when the refactor lands.
- **Fix commit:** (pending — see plan above)

---

### BUG-021 — Walker with `runOnly: [downstream-node]` doesn't hydrate upstream completed instances
- **Status:** fixed
- **Discovered:** 2026-05-29
- **Reporter:** claude (during dhee_critique_node live verification)
- **Symptom:** Re-dispatching the bundle with `runProjectViaBundle({ runOnly: ['shot_image_prompt'] })` after invalidating one item (`shot_image_prompt:scene_1_shot_3`) fails the FIRST executed instance with:
  ```
  llm.generate: prompt template references variable(s) that were not provided:
    scenes_plan, item_id, shot_image_prompt, world_style, characters_plan, settings_plan
  ```
  `item_id` being on the missing list is the smoking gun — the runner sees `ctx.itemId === undefined`. The walker dispatched the collection node as a single stage-level call rather than fanning out per-item.
- **Evidence:** Live run on Ruby V4 via `dhee_critique_node(shot_image_prompt, scene_1_shot_3, ...)` → applied → walker fired → first node returned the error above. `dhee_get_status` afterward showed `shot_image_prompt` in failed nodes; OTHER items of that collection (which the walker should have iterated) were never attempted.
- **Suspected root cause:** `runOnly` filtering happens at the node-id level inside the walker's main loop, but the collection-materialization step (which expands the bare node into per-item instances) may be gated upstream of that, so when only the bare id is in the runOnly set, no items get materialized. Walker then falls through to a stage-mode invocation with empty inputs.
- **Manifestations to test:**
  - `runOnly: [collection-node-id]` with NO items in walkState → walker should still iterate (find items via the bundle's itemSource + project state).
  - `runOnly: [collection-node-id]` with SOME items completed → walker should iterate ALL items, re-running invalidated ones and skipping completed ones via cache.
  - `runOnly: [collection-node-id:itemId]` (composite key) → should run JUST that one item.
  - `runOnly: [stage-node-id]` → still works (existing behavior, regression-guard it).
  - Cascade behavior: downstream nodes after a `runOnly` collection still get their inputs from the completed items.
- **Test:** `tests/dag/walkerRunOnlyUpstreamInputs.test.ts > BUG-021 — runOnly hydrates upstream completed instances for downstream inputs`
- **Fix:** When `runOnly` excludes a node from the run cascade, the walker now still walks that node's instances and populates `outputAbs` / `outputRel` / `status` from walkState before `continue`ing past the dispatch step. Downstream `buildRunnerConfig` then sees the hydrated outputs in `instancesById` and feeds them into `ctx.inputs` normally.
- **Fix commit:** (pending; same commit as BUG-022 investigation entry)

---

### BUG-024 — comfy.qwen_edit_chain picks wrong character refs when prompt uses natural names instead of snake_case IDs
- **Status:** fixed (proper schema-first fix; the earlier `pickCharacterRefs` heuristic patch was retired)
- **Discovered:** 2026-05-29
- **Fixed:** 2026-05-29
- **Reporter:** ganaraj + claude (post-Qwen-quality review on Ruby V4 refined)
- **Symptom:** Refined shot images came out with the wrong character in scenes where the character's name in the prompt didn't match the character's id verbatim. Concrete cases on Ruby V4 refined:
  - `scene_2_shot_3` ("pawn shop owner... polishing a gold chain"): rendered owner as a lean dark-haired man in a leather jacket. He looked like Angel.
  - `scene_2_shot_4` ("owner drops the chain"): refs sent were ruby + angel — no owner ref at all.
  - `scene_2_shot_6` ("Ruby presses gun against the owner's forehead"): only ruby.png sent; gun-direction also drifted because Qwen had no anchor for the owner.
- **Evidence:** `assets/images/shots/*_first.meta.json` sidecars record the exact `charRefs` list passed to Qwen. For all three shots above, the pawn_shop_owner reference image was NOT in the list — even though the prompt clearly referenced the character.
- **Root cause:** `comfyQwenEditChain.ts:161` filtered character IDs by `fullPrompt.toLowerCase().includes(cid.toLowerCase())`. IDs are snake_case (`pawn_shop_owner`); prompts use natural language ("pawn shop owner", "the owner"). Zero matches → fallback to alphabetic charIds → `angel` + `lamborghini_driver` win the slots regardless of who's in the scene.
- **First attempt (tactical, retired):** `pickCharacterRefs` — three-tier substring heuristic (verbatim id, id-with-spaces, last id-token ≥5 chars). Shipped in `b8f656a` to unblock the in-flight refined run, then immediately reviewed and judged the wrong abstraction: the runner shouldn't be reverse-engineering the LLM's intent from prose when the LLM is structured-output capable.
- **Proper fix (schema-first):** Added `characters: string[]` (max 2, snake_case ids) to `schemas/shot_image_prompt.schema.json` as a required field. Updated `prompts/shot_image_prompt.md` so the LLM emits the list directly with the right semantics (primary subject first, only visually-present characters). Runner reads `promptJSON.characters` and uploads in declared order. No fallback — if `characters` is missing the runner fails loudly with a directive to re-run shot_image_prompt under the new schema. `pickCharacterRefs` deleted along with its tests. Matches the legacy (pre-bundle) projects' explicit-references design (Ruby V3 had `references: [{ refId, type, imageNumber }]` per shot — the new bundle had simply dropped it; this restores the principle).
- **Test:** `tests/dag/narrativeQwenChainBundle.test.ts` — asserts schema requires `characters`, items are strings, maxItems is 2, and the prompt template names the field + the snake_case + primary-subject-first conventions.
- **Fix commits:** `b8f656a` (heuristic; retired), `<this commit>` (schema-first; proper)
- **Migration:** existing shot_image_prompt JSONs that predate this schema are missing the field and will fail at runner-time with a clear error message. Re-LLM via `dhee_critique_node` or by deleting the prompt JSON + walking the bundle. There's no silent fallback — the design intent is that the LLM declares its cast.

---

### BUG-023 — Critique cascade doesn't re-render downstream non-text artifacts (stale-output cache hit)
- **Status:** fixed (over-approximation; per-item granularity is a follow-up)
- **Discovered:** 2026-05-29
- **Fixed:** 2026-05-29
- **Reporter:** ganaraj + claude (during Ruby V4 refined batch refinement of 22 broken shots)
- **Symptom:** After agent applies 22 critiques via `dhee_critique_node(applyOnly:true)` and then issues one `dhee_run_bundle` to process the batch, the walker:
  - ✅ re-runs every `shot_image_prompt:scene_X_shot_Y` LLM (good — the refined prompt JSONs land on disk with longer, structurally-correct content)
  - ❌ **marks every downstream `shot_image:scene_X_shot_Y` as `completed` without invoking the Qwen runner** — the old (cloned) PNGs at the expected outputPath are preserved, no Comfy call is made
  - ❌ then runs LTX `scene_clip` chunks against the OLD shot_image PNGs (because the cascade did fire to scene_clip, just with stale upstream inputs), producing scene videos that bake in the broken images we were trying to fix
- **Evidence:**
  - All `Ruby V4 refined/assets/images/shots/*.png` retain their mtime of `19:56` (cp -R clone time). Not one PNG was rewritten by the run that finished at ~21:38.
  - `walkState.nodes['shot_image:*'].metadata.promptId` is `null/false` for every entry. A real Qwen call would have stamped the Comfy prompt_id.
  - `walkState.nodes['shot_image:*'].completedAt` is `~1780069057xxx` (≈21:37) — within milliseconds of every other entry, indicating a bulk synthetic write, not 22 separate Comfy renders.
  - `pendingCritiques: {}` after the run — confirms the LLM phase DID consume + clear the critiques (so the prompts WERE rewritten).
  - The two scene_clip chunks that didn't have a pre-existing file on disk (`scene_3_chunk_1`, `scene_3_chunk_2`) DID get rendered with real promptIds — confirming the "file exists at outputPath = cache hit" hypothesis for the skip.
- **Suspected root cause:** Two-part. (a) `invalidateNodes` only marks the directly-targeted node — it does NOT cascade-invalidate downstream nodes. (b) The walker, when reaching a downstream node whose walkState is still `completed` with a present file at outputPath, treats it as cache-hit and writes a fresh `completedAt` without invoking the runner. The combination means that a critique on an upstream LLM node never reaches the downstream image/video render. Compare with the explicit user-driven "Regenerate" right-click (UX-8), which DOES invalidate downstream — that path uses a different invalidation routine that walks the graph.
- **Manifestations to test:**
  - Tiny bundle (prompt LLM → image comfy → video comfy), all completed in walkState with files on disk, stamp a `pendingCritique` for the prompt node + invalidate prompt node, run walker → image node + video node MUST be re-invoked (not silently skipped) so the new prompt actually drives a new image + video.
  - Regression: an UNTOUCHED downstream node (no upstream change) is still cache-skipped via the file-exists check — so the fix is "force re-render when upstream re-ran during the walk", not "always re-render".
  - Both stage and collection downstreams are tested; per-item invalidation cascades to per-item downstream invalidation (`shot_image_prompt:s1_3` → `shot_image:s1_3` only, not `shot_image:s1_4`).
  - `runOnly` interaction: `runOnly: [prompt-node-only]` should still cascade-invalidate downstream UNLESS the caller explicitly clamps to only the prompt (e.g. dry-run "show me the new prompt text without re-rendering" via a future `dryDownstream` flag).
- **Workaround in the meantime:** when batching critiques with `applyOnly:true`, also manually invalidate the downstream `shot_image:<item>` entries (delete them or set status:invalidated) before the final `dhee_run_bundle`, OR drop the on-disk PNG so the file-exists check misses.
- **Test:** `tests/dag/walkerCritiqueCascade.test.ts > BUG-023 — pendingCritique on upstream forces downstream non-text re-render`
- **Fix:** Walker now tracks a `reRunInThisWalk: Set<string>` of node ids whose runner was actually invoked during this walk. The per-instance cache-skip check at `walker.ts:946` consults this set: if any of `node.inputs[].from` was re-run, the cache-skip is bypassed and the runner is invoked for fresh output. Successful runs add their bare node id to the set. Over-approximation by design — sibling items of an item-level re-run will also re-render. Per-item granularity respecting `inputs[].scope='matching'` is tracked as the `it.todo` in the regression test.
- **Fix commit:** 3e86ae6

---

### BUG-022 — Walker walkState-write wipes sibling fields from project.json
- **Status:** investigating
- **Discovered:** 2026-05-29
- **Reporter:** claude (during dhee_critique_node live verification)
- **Symptom:** `dhee_critique_node` stamps `pendingCritiques[<key>]` into `project.json`, then invalidates the target node, then dispatches the bundle. After the dispatch returns, `pendingCritiques` is GONE from `project.json` — even though the runner never reached its clear-on-success step (BUG-021 prevented the LLM call from happening, so the write block that clears the critique never ran).
- **Evidence:**
  - Before apply: `project.json` had `pendingCritiques: { "shot_image_prompt:scene_1_shot_3": "<critique text>" }` (verified via `jq` post-invalidate, pre-dispatch).
  - After apply + walker failure: `jq '.pendingCritiques' project.json` returns `null`. The critique was never consumed by `llm.generate` (the runner failed at template substitution, BEFORE the read-critique block).
- **Suspected root cause:** The walker reads `project.json`, mutates only the `walkState` subtree, and writes a reconstructed object back — using a known-field allowlist or `JSON.stringify(knownObject, null, 2)` rather than a deep merge. Any field outside that allowlist (`pendingCritiques`, future sibling state) gets wiped on the first walkState update.
- **Manifestations to test:**
  - Add arbitrary unrecognized field `project.json` (e.g. `_userNotes: "..."`); kick the walker; verify the field survives.
  - Critique apply → walker runs → critique key persists IF the runner failed before reaching `pendingCritiques` consumption.
  - Future sibling stores (e.g. `runnerOverrides`, `branchTags`) need to be designed AROUND this bug OR the walker write needs to deep-merge.
- **Investigation status (2026-05-29):** code review of `saveWalkState`, `invalidateNodes`, and `runProjectViaBundle` shows all three use shallow-merge writes that already preserve sibling fields. The observed wipe may have been a timing artifact (test repro happened across multiple sessions while bundle-dispatch failed midway). Pending a second repro under controlled conditions. If the next dhee_critique_node run with the BUG-021 fix in place still wipes `pendingCritiques`, return here with a precise repro.
- **Test:** (pending second repro)
- **Fix commit:** (pending)

---

### BUG-026 — Scene chunking is resolution-blind → LTX video OOMs at 720p
- **Status:** fixed
- **Discovered:** 2026-06-03
- **Reporter:** user (diagnosed the root cause) + claude (repro)
- **Symptom:** Re-rendering a `scene_clip` chunk on the `narrative_prompt_relay` bundle at true 720p (after the bundle baseline was raised 854×480 → 1280×720 so "720p means 720p") OOMs on the RTX 3060 (12GB). Comfy `/history` reports `status_str: error`, `node 47 SamplerCustomAdvanced`, `torch.OutOfMemoryError`. It was tempting to conclude "the 3060 can't do 720p video" — but it can.
- **Evidence:**
  - `GET /history/<id>` for the Mumbai-Rain-720p `scene_1_chunk_1` render: `exception_type: torch.OutOfMemoryError`, `node_type: SamplerCustomAdvanced`. The LTXAV model *loaded* fine (got all the way to node 47); the OOM was the diffusion sampler's latent, not model staging.
  - An LTX-2 chunk is sampled as a single latent of `(frames × width × height)`. All relay bundles declare `chunkBy.limit: 1000` (frames/chunk), tuned at 854×480. A 1000-frame chunk = `1000 × 854 × 480 = 409,920,000` px·frames at 480p (fits). At 1280×720 the *same* 1000-frame chunk = `1000 × 1280 × 720 = 921,600,000` px·frames — 2.25× the latent volume → OOM.
  - `chunkBy.limit` is the AUDIO-LATENT model cap (a frame count, resolution-independent). Nothing scaled the per-chunk frame count down as resolution rose, so the chunker handed the sampler a latent 2.25× too big.
- **Suspected root cause:** confirmed — the walker's chunk materialization (`materializeCollection`, both the legacy 'scene' path and the upstream-driven scenes+shots path) used `node.chunkBy.limit` verbatim as the per-chunk frame cap, with no awareness of the render resolution the runner would use.
- **Manifestations to test:**
  - A scene that fits in ONE chunk at 480p must split into MULTIPLE chunks at 720p (same plan, same bundle) — `walkerChunkByUpstream.test.ts > (R1)`.
  - Without a VRAM budget declared, resolution must NOT change chunk count (legacy bundles) — `(R2)`.
  - Pure cap math: baseline 854×480 → 1000 (unchanged), 1280×720 → 440, 1920×1080 → 192, orientation-agnostic, 8-frame aligned, never below 8, never above `limit` — `chunkBudget.test.ts`.
- **Fix:** added `chunkBy.maxFramePixels` (the GPU-safe `frames × pixels` budget = `1000 × 854 × 480 = 409,920,000`) to the schema + all four relay bundles. New pure helper `effectiveFrameCap(limit, w, h, maxFramePixels) = min(limit, floor(maxFramePixels / (w×h)))` aligned down to 8. The walker computes the render dims at materialization time (`applyAspect(aspect, cfg.w, cfg.h, resolution)`) and scales the per-chunk cap, so 720p produces shorter chunks (~440 frames) that each fit in 12GB. True 720p video now works on the 3060 — it just uses more, shorter chunks.
- **Test:** `tests/dag/chunkBudget.test.ts`; `tests/dag/walkerChunkByUpstream.test.ts > resolution-aware chunk cap (maxFramePixels) > (R1)/(R2)`
- **Fix commit:** (this branch — fix/bundle-errors)

---

### BUG-027 — Local Comfy HTTP-poll fallback never detects a server-side execution error (OOM) → run wedges in_progress forever
- **Status:** fixed
- **Discovered:** 2026-06-03
- **Reporter:** claude (while reproducing BUG-026)
- **Symptom:** When a local Comfy prompt errors on the GPU (e.g. OOM) AND the websocket has already dropped to the HTTP-polling fallback, `waitForCompletion` polls the dead prompt indefinitely. The node stays `in_progress`, the BackgroundTaskRunner stays `active`, and the run never fails or notifies — the exact "stuck and can't recover" class the user has flagged before. Observed: the Mumbai OOM at 07:50:59 was still `in_progress` 13+ minutes later with no further log activity.
- **Evidence:**
  - `debug.log`: last line `[queueAndWaitWS] WS silent for 67s — falling back to HTTP polling` at 07:52:37, then silence. The prompt had already errored (`status_str: error`) at 07:50:59.
  - `walkState.nodes['scene_clip:scene_1_chunk_1'].status === 'in_progress'` and `runnerStatus().active === true` ~13 min after the OOM.
  - Code: `waitForCompletionInner`'s local branch matched none of its exit conditions for an errored prompt — `outputs` empty (no completed-via-outputs), `status.completed`/`status_str==='success'` false (not completed), and the missing-poll fast-fail is gated on `!history` (history was PRESENT, just errored). The cloud branch *did* handle `status === 'error'`; the local branch had no equivalent.
- **Suspected root cause:** confirmed — missing `status_str === 'error'` check in the local HTTP-polling branch.
- **Manifestations to test:**
  - A mocked `/history` returning `status_str: 'error'` with empty outputs must make `waitForCompletion` resolve to `{status:'error'}` quickly, not time out — `ComfyUIClient.test.ts > local error detection`.
- **Fix:** in `waitForCompletionInner` (local branch), after fetching a present `history`, return `{status:'error', prompt_id}` when `history.status?.status_str === 'error'`. Logs the message kinds for diagnosis. This pairs with the always-notify / auto-retry resilience in the desktop's `onRunTerminal` — an OOM now fails fast and surfaces, rather than hanging (and an OOM is correctly NOT classified transient, so it won't auto-retry into another OOM).
- **Test:** `tests/services/comfyui/ComfyUIClient.test.ts > ComfyUIClient.waitForCompletion local error detection`
- **Fix commit:** (this branch — fix/bundle-errors)

---

### BUG-028 — Agent re-renders only the video on a resolution request, leaving images stale
- **Status:** fixed
- **Discovered:** 2026-06-03
- **Reporter:** user (anticipated) + claude (reproduced via headless drive)
- **Symptom:** Asked (via the headless pi-agent) to take eye-of-the-storm to true 720p — "the shot images need to be actual 720p too" — the agent invalidated only `scene_clip` + `final_video` and left all 39 `shot_image` nodes at their old 720×408 size. It then rendered 720p video conditioned on stale low-res frames (not true 720p quality).
- **Evidence:**
  - `lastInvalidatedIds: ["scene_clip","final_video"]`; all `shot_image:*` stayed `completed`; sample image dims 720×408 (old long-edge "720p"), final video 640×384.
  - The project's `resolution` was ALREADY 720 — the images are low-res only because they were rendered BEFORE the aspect-edge semantics fix (when 720p meant long-edge 720 → 720×408). So nothing "changed" from the agent's view, and `completed` looks fine; it had no signal the images were stale.
- **Suspected root cause:** confirmed — the agent has no way to tell that a `completed` artifact's dimensions no longer match the target aspect+resolution. Re-running the video stage felt sufficient.
- **Manifestations to test:**
  - Pure staleness check: old long-edge (720×408) vs true 720p (1280×720) → stale; LTX rounding (704 vs 720) → not stale; orientation flip → stale; square refs → never stale — `resolutionStaleness.test.ts`.
  - Tool flags only the stale image, leaves fresh + square alone — `dheeCheckResolution.test.ts`.
- **Fix:** new read-only agent tool `dhee_check_resolution(projectDir)` — reads each completed image's real dimensions (dependency-free PNG IHDR parse) and compares to `applyAspect(aspect, baseline, resolution)`, listing the stale ones. Pure helpers in `src/dag/resolutionStaleness.ts` (`isResolutionStale`, `readPngDims`). SKILL.md now requires: on any resolution/aspect request (or "looks low-res"), set the field → `dhee_check_resolution` → regenerate the flagged IMAGE nodes (cascades to video) — never stop at the video stage. `resolution` added to the documented project-field list.
- **Test:** `tests/dag/resolutionStaleness.test.ts`; `tests/unit/dheeCheckResolution.test.ts`; allowlist via `tests/unit/dheeAgentTools.test.ts > DHEE_TOOL_NAMES`
- **Fix commit:** (this branch — fix/bundle-errors)

---
