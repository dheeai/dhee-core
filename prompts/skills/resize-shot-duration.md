---
name: resize-shot-duration
description: Lengthen or shorten a single shot's duration. Triggers when the user asks for a duration change ("shot 1 is too short for the narration", "make s1 shot 3 longer — 6 seconds", "trim shot 5 to 4 seconds", "extend shot 1 by 2s"). The timeline auto-reflows on save, so this skill only edits per-shot `duration` fields — no manual start/end math.
---

# Resize a single shot's duration

## Pre-flight checks (run BEFORE editing anything)

1. **Confirm the new duration is within LTX limits.** Practical
   ceiling per render is **~8 seconds** on the standard `ltx23_fl2v_*`
   / `ltx23_i2v_*` workflows. If the user asks for >8s:
   - Push back. Say: *"LTX can't render >8s in a single shot. Two
     options: (a) cap this shot at 8s and let the narration carry
     over into shot N+1, (b) use v2v_extend to chain two renders.
     Which?"*
   - Don't silently truncate. Don't proceed without their answer.
2. **Confirm the new duration is positive and ≥ 1s.** Sub-1s shots
   don't make cinematic sense and the motion directive can't fill
   anything meaningful.

## Three files, three `duration` writes — no time math

A duration change touches three on-disk artifacts. Each one has a
single `duration` field for the target shot. Edit each, save, done —
the timeline's `startTime` / `endTime` / `totalDuration` are derived
fields that get reflowed automatically on load and on save by
`normalizeSegmentTimes` (timeline architecture: duration is source
of truth, time ranges are cache).

| # | File | Field to change |
|---|------|------------------|
| 1 | `prompts/videos/scenes/scene_<N>.plan.json` | `shotPlan[i].duration` where `shotPlan[i].shotNumber === <target>` |
| 2 | `prompts/videos/scenes/scene_<N>.json` | `shots[i].duration` where `shots[i].shotNumber === <target>` (this is what `executeShotVideo` reads at render time — **don't skip this file**) |
| 3 | `timeline.json` | the segment with `id === "scene_<N>_shot_<M>"` — set its `duration`. Leave `startTime`/`endTime` alone; the next load/save reflows them. |

## Steps

1. **Read the three files first** so you can see the current duration
   and confirm they agree. They should. If they don't, surface the
   disagreement to the user — don't paper over it.

2. **Edit each file.** Use the `edit` tool with enough context in
   `oldText` that the match is unambiguous (not just `"duration": 3,`
   — include the surrounding line or two). Each file gets exactly one
   targeted `duration` field change.

   - In `scene_<N>.plan.json`: match within the `shotPlan[]` entry
     whose `shotNumber` matches the target.
   - In `scene_<N>.json`: match within the `shots[]` entry whose
     `shotNumber` matches the target.
   - In `timeline.json`: match within the segment whose `id`
     matches `scene_<N>_shot_<M>`. **Do NOT manually adjust
     `startTime` or `endTime`** — those are derived fields. Hand
     edits to them will be silently overwritten on the next
     `saveTimeline` call. Just touch `duration`.

3. **Invalidate consumers (NOT producers).**

   The duration change cascades through:
   - `shot_motion_directive` — pace-aware; a 3s directive playing
     over a 5s shot leaves dead air at the end. Must regen.
   - `shot_video` — renders the actual clip at the new length.

   Do NOT invalidate:
   - `scene_shot_plan:scene_<N>` — re-running the planner LLM would
     overwrite your hand-edited plan with whatever it generates
     (possibly different shot count / structure).
   - `scene_video_prompt:scene_<N>` — Stage-C deterministic
     assembler; re-running would re-derive from the (now-edited)
     plan + shot_breakdowns. Your edit to `scene_<N>.json` is
     preserved by NOT invalidating this node.
   - `shot_image:…` / `shot_image_last_frame:…` — frames don't
     change; only the video clip's length does.

   Call `dhee_invalidate` once per consumer node:

   ```
   dhee_invalidate node=shot_motion_directive:scene_<N>_shot_<M>
   dhee_invalidate node=shot_video:scene_<N>_shot_<M>
   ```

4. **Run:**

   ```
   dhee_run_to scope='last_invalidated'
   ```

   The motion directive regenerates against the new `duration`
   read from `scene_<N>.json`, then `shot_video` renders the clip
   at the new length. `final_video` re-stitches; the timeline's
   downstream segments shift automatically because the assembler
   reads the normalized timeline.

## Edge cases

- **The shot is the final shot of the final scene.** No segments
  downstream to worry about. Just edit the three files; total
  duration grows or shrinks naturally.
- **Multiple shots in one request.** Call this skill once per shot,
  in any order — the normalize pass handles whatever cumulative
  reflow is needed.
- **>8s requested.** Don't proceed silently — push back at
  pre-flight check #1.

## Confirming the result

After the run finishes:

1. Read the regenerated `prompts/motion/scene_<N>_shot_<M>.json`.
   Confirm the prose pacing matches the new duration — e.g., a 6s
   directive shouldn't read like a 2s beat.
2. Check the new shot video file's actual duration via `ffprobe` or
   inspect the timeline segment after the run (it'll have been
   reflowed). It should equal `<new>` ± 0.1s.
3. Summarize to the user:
   *"Shot <M> in scene <N> resized: <old>s → <new>s. New total
   duration: <X>s. Downstream segments reflowed automatically."*

If the regenerated motion directive looks weak for the new length
(common when extending by >2x — the LLM may pad rather than rewrite),
offer to re-roll just the motion directive with explicit guidance
about what should happen across the extra seconds.

## What changed from the previous version of this skill

The earlier version of this skill walked through manual timeline
reflow math: "delta = new - old; every segment with startTime >=
target.endTime gets startTime += delta, endTime += delta; update
totalDuration += delta." That math is gone — it's done automatically
by `normalizeSegmentTimes` on save and load. The skill is now ~40%
shorter and an order of magnitude harder to corrupt the file with.
