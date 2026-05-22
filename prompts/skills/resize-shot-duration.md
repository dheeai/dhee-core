---
name: resize-shot-duration
description: Lengthen or shorten a single shot's duration. Triggers when the user asks for a duration change ("shot 1 is too short for the narration", "make s1 shot 3 longer — 6 seconds", "trim shot 5 to 4 seconds", "extend shot 1 by 2s"). Edits THREE files (scene plan, scene video prompt, timeline), reflows downstream segments, then invalidates the motion directive and shot video so they regenerate at the new length. NOT for changing multiple shots in one go — call this skill once per shot.
---

# Resize a single shot's duration

Use this when the user asks to change ONE shot's duration. Multiple
shots in one request → call this skill once per shot, each as its
own invocation.

## Pre-flight checks (run BEFORE editing anything)

1. **Confirm the new duration is within LTX limits.** Practical
   ceiling per render is **~8 seconds** on the standard `ltx23_fl2v_*` /
   `ltx23_i2v_*` workflows. If the user asks for >8s:
   - Push back. Say: *"LTX can't render >8s in a single shot. Two
     options: (a) cap this shot at 8s and let the narration carry
     over into shot N+1, (b) use v2v_extend to chain two renders.
     Which?"*
   - Don't silently truncate. Don't proceed without their answer.
2. **Confirm the new duration is positive and ≥ 1s.** Sub-1s shots
   don't make cinematic sense and the motion directive can't fill
   anything meaningful.
3. **Read the three files first** so you know the current state:
   - `prompts/videos/scenes/scene_<N>.plan.json` (scene_shot_plan output)
   - `prompts/videos/scenes/scene_<N>.json` (scene_video_prompt output)
   - `timeline.json` (project root)

   Note the **current** duration of the target shot in all three.
   They should agree. If they don't, surface that as a problem — the
   project is already inconsistent and a duration change will make
   it worse. Resolve consistency first or escalate to the user.

## The three files that need editing

A duration change is NOT a one-file edit. Three places have to agree
or final video assembly breaks:

| # | File | Field to change | What goes wrong if you skip |
|---|------|-----------------|------------------------------|
| 1 | `prompts/videos/scenes/scene_<N>.plan.json` | `shotPlan[i].duration` AND top-level `totalDuration` (add delta) | Plan disagrees with renderer — confusion on next run-to; planner LLM may re-plan if invalidated |
| 2 | `prompts/videos/scenes/scene_<N>.json` | shot's `duration` in `shots[]` | **Video renders at OLD length** — `executeShotVideo` reads duration from here, not from the plan |
| 3 | `timeline.json` | Target segment `endTime`/`duration` AND every downstream segment's `startTime`/`endTime` AND top-level `totalDuration` | Final video assembly stitches with wrong boundaries — segments overlap or leave gaps |

## Step-by-step

### 1. Compute the delta

```
delta = newDuration - oldDuration
```

Positive = lengthening, negative = shortening.

### 2. Edit `scene_<N>.plan.json`

- Find `shotPlan[]` entry where `shotNumber === <target>`.
- Set `duration = <new>`.
- Set top-level `totalDuration = totalDuration + delta`.

### 3. Edit `scene_<N>.json`

- Find `shots[]` entry where `shotNumber === <target>`.
- Set `duration = <new>`.
- This is what the renderer (`executeShotVideo`) reads — **don't skip
  this file**.

### 4. Edit `timeline.json`

The target segment id is `scene_<N>_shot_<M>`.

- Target segment: set `duration = <new>` and `endTime = startTime + <new>`.
- **Every segment with `startTime >= target.endTime` (OLD endTime) gets
  shifted by `delta`:** `startTime += delta`, `endTime += delta`.
  - Apply to ALL of them — later shots in the same scene AND later
    scenes' shots.
- Top-level `totalDuration += delta`.

This is the load-bearing math. Triple-check:
- The target segment's new `endTime - startTime` equals `<new>`.
- The first downstream segment's new `startTime` equals the target
  segment's new `endTime`.
- The last segment's new `endTime` equals the new top-level
  `totalDuration`.
- No segment has `startTime > endTime` or `duration < 0`.

If any of those fail, **DO NOT WRITE** — surface the math error to
the user with the proposed values for review.

### 5. Invalidate consumers (NOT producers)

Per the producer-vs-consumer principle (see `edit-and-regen-shot`
skill), invalidate the things that CONSUME the changed duration so
they regen, NOT the upstream producers whose files you just edited.

For a duration change, invalidate:

| Node | Why |
|---|---|
| `shot_motion_directive:scene_<N>_shot_<M>` | The motion directive is pace-aware — a 3s plan becomes 5s of static drift if directive doesn't regen |
| `shot_video:scene_<N>_shot_<M>` | Renders at the new duration; reads from `scene_<N>.json` you just edited |

Do **NOT** invalidate:
- `scene_shot_plan:scene_<N>` — re-running it makes the planning LLM
  re-author the plan, which can change shot count and structure. You
  hand-edited the plan; you don't want the LLM redoing it.
- `scene_video_prompt:scene_<N>` — same reason; this is a Stage-C
  assembly node that would re-derive from the plan + shot_breakdowns.
  Your edit to `scene_<N>.json` is preserved by NOT invalidating this
  node.
- `shot_image:…` / `shot_image_last_frame:…` — frames are identical;
  only the video clip's length changes.

Call `dhee_invalidate` once per node:

```
dhee_invalidate node=shot_motion_directive:scene_<N>_shot_<M>
dhee_invalidate node=shot_video:scene_<N>_shot_<M>
```

### 6. Run

```
dhee_run_to scope='last_invalidated'
```

The motion directive regenerates (its prompt sees the new
`duration` from `scene_<N>.json`), then the video renders at the new
length.

## Edge cases worth flagging

- **The shot is the final shot of the final scene.** Top-level
  `totalDuration` still updates, but there's nothing to shift after
  it. Still update file #3's top-level `totalDuration`.
- **Multiple shots in the request.** Call this skill once per shot,
  in shot-number order. Each invocation re-computes delta and
  reflows from its target onward. Do NOT batch — the math compounds
  in ways that are easy to get wrong.
- **The user wants to extend BEYOND LTX's 8s ceiling.** Don't proceed
  silently. Push back per pre-flight check #1.
- **The shot already has rendered video at the old duration.** The
  invalidation in step 5 marks the video stale; the regen in step 6
  produces a new render at the new length. Old render stays on disk
  under the original filename (the executor writes a new file with
  a fresh hash). That's fine — `assets/manifest.json` points at the
  latest.
- **Inconsistency between the three files at pre-flight time.** Don't
  paper over it by overwriting. Stop, summarize the disagreement for
  the user, ask which value is authoritative, then proceed.

## Confirming the result

After the run finishes:

1. Read the regenerated `prompts/motion/scene_<N>_shot_<M>.json`.
   Confirm the prose pacing matches the new duration — e.g., a 6s
   directive shouldn't read like a 2s beat.
2. Check the new shot video file's actual duration via `ffprobe` (or
   inspect the timeline segment's `endTime - startTime`). It should
   equal `<new>` ± 0.1s.
3. Summarize to the user:
   *"Shot <M> in scene <N> resized: <old>s → <new>s. Downstream
   <K> segments shifted by <delta>s. New total: <totalDuration>s."*

If the regenerated motion directive looks weak for the new length
(common when extending by >2x — the LLM may pad rather than rewrite),
offer to re-roll just the motion directive with explicit guidance
about what should happen across the extra seconds.

## What NOT to do

- **Don't edit only one of the three files.** All three or none.
- **Don't invalidate `scene_shot_plan` or `scene_video_prompt`** —
  those would re-run the planning LLMs and overwrite your math.
- **Don't try to do the timeline math in your head for >5 segments
  to reflow.** Read `timeline.json`, compute, write a fresh copy.
  Errors compound silently.
- **Don't proceed past pre-flight if the user wants >8s in a single
  shot.** That's outside LTX's reliable range; silent truncation
  produces an unrendered video and a confused user.
- **Don't skip the verification step.** Reading the regenerated
  motion directive + confirming the new video length is part of
  the skill, not optional polish.
