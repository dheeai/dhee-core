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
