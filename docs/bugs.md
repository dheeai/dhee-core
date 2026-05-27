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
