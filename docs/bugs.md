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
