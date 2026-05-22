# Planner over-uses motion verbs in shot cameraWork — blocks skip-LF heuristic

## Status: OPEN — 2026-05-22

## Problem

The `isHoldingBeat` heuristic in `shotImagePipeline.ts` (skip-LF branch)
correctly identifies holding-beat shots and strips `frames.last_frame`
from the assembled JSON, routing video gen to `ltx23_i2v_*` instead of
`ltx23_fl2v_*`. The heuristic fires when:

  purpose ∈ {set_the_world, set_the_mood, hold_emotion, show_reaction,
             show_dialogue, show_clue, punctuate}
  AND cameraWork contains NO motion verb
       (push in / pull back / pan / dolly / tracking / tilt / zoom /
        follow / crane / orbit / whip / swirl / rack focus / arc)

Empirically the heuristic is too conservative because **the planner LLM
sprinkles camera-motion verbs onto nearly every dialogue/reaction shot
even when the story doesn't call for them.** Example from "Better Image"
project — two characters talking on a static observation deck:

| Shot | Purpose | cameraWork |
|---|---|---|
| 1 | show_action | wide shot ... static frame |
| 2 | show_dialogue | descend and **push in** to medium shot |
| 3 | show_action | **pull back** to a wider neutral angle |
| 4 | show_dialogue | **push in** to Close-up |
| 5 | show_dialogue | reverse to Medium shot, **tracking** left |
| 6 | show_dialogue | medium shot, eye-level, slow **push-in** |
| 7 | show_dialogue | medium close-up, low angle, slight **push-in** |
| 8 | show_dialogue | reverse to OTS, medium shot — STATIC ✅ |
| 9 | show_dialogue | medium close-up, **push-in** as Sera picks up |
| 10 | show_dialogue | medium close-up, subtle **push-in** |
| 11 | show_dialogue | reverse to medium close-up, steady — STATIC ✅ |
| 12 | show_dialogue | reverse OTS, slight (truncated) |
| 13 | show_dialogue | medium shot, slight low angle, static ✅ |
| 14 | show_dialogue | medium CU with a slight **rack focus** |
| 15 | hold_emotion | slow **push-in** on Malachor's reflection |

3 of 15 shots qualify (8, 11, 13). The story justifies *maybe* 1–2 camera
moves at most — the rest of "push in"s are reflexive prose from the
planner, not creative choices. As a result we render LF + Klein edit + an
FL2V workflow for shots that should run i2v with no motion anchor.

## Cost shape

- Per-project: ~12 shots × wasted LF Klein edit (~$0.02-0.03) = $0.25-0.36
- Plus the wasted Call-3 LLM cost for the LF prompt (~$0.001-0.01)
- Plus a slower video render (FL2V is ~10% slower than i2v on LTX 2.3)

Multiplied across hundreds of project renders during iteration: not
trivial, and the rendered output is no better — likely worse, since LF
prompts for static beats encode mid-action poses (see `skip-wasted-LF`
diagnosis re: LF-as-mid-action).

## Diagnosis

Two root causes intertwined:

1. **The `scene_breakdown_shot_guide` (or whatever prompt drives shot
   `cameraWork`) doesn't say "don't add motion if the beat is static."**
   The LLM treats "describe the camera" as an invitation to embellish.
   "Push in" is a low-cost detail it can always add.
2. **There's no examples-of-static-shots calibration in the guide.** All
   the worked examples likely involve some camera motion, so the model
   learned that "good cameraWork = always include a motion verb."

## Three remediation paths (not mutually exclusive)

### Path 1 — Tighten the planner prompt (highest leverage)

Edit `prompts/skills/defaults/scene_breakdown_shot_guide.md` (or whichever
guide produces `cameraWork`) to add:

> **Static is OK — preferred for dialogue and reaction beats.** If the
> shot's purpose is `show_dialogue`, `show_reaction`, `hold_emotion`,
> `set_the_mood`, `set_the_world`, `show_clue`, or `punctuate`, and the
> story doesn't explicitly call for camera motion, prefer prose like:
>
>   - "medium shot, eye-level, locked off"
>   - "close-up, slight low angle, steady"
>   - "wide, static frame"
>
> Camera motion ("push in", "pan", "tracking", "dolly", "rack focus")
> should be EARNED by a story beat — a reveal, a shift in emotional
> stakes, a moment of dawning recognition. Adding "subtle slow push-in"
> by default is filler. Static cameras are the cinema-language norm for
> two-shots of seated dialogue.

Cost: 1 prompt edit, ~30 min including a regen + audit on Better Image.
Risk: low — guide-only change, reversible.

### Path 2 — Add a heuristic debug log

Currently `applyHoldingBeatSkip` only logs when it FIRES. When it
doesn't fire, there's no visibility into *why* — was the purpose
wrong, the cameraWork motion-verb-tripped, or the brief un-loadable?

Add an info-level log on every shot:

```
[shot_image_prompt holding-beat] scene_1_shot_2: purpose=show_dialogue,
  cameraWork="descend and push in to medium shot...", decision=SKIP-NOT-FIRED
  reason="motion verb: push in"
```

This makes the next debugging round 10× faster. ~15 lines of code.

### Path 3 — Loosen the motion-verb veto

Currently ANY occurrence of a motion verb anywhere in cameraWork
disqualifies the shot. Alternatives:

- **Position-aware:** only veto if the motion verb is in the FIRST
  clause (before the first comma). "medium shot, eye-level, subtle
  push-in at the end" → first clause has no motion → still skip.
- **Magnitude-aware:** ignore "subtle", "slight", "micro" qualifiers
  preceding a motion verb. "slight push-in" → skip.
- **Allowlist a small motion budget:** static frame with one tiny move
  is still i2v-renderable (LTX can do a 30% zoom and stay coherent).

Higher risk than Path 1 — moves us toward judging the planner's output
rather than respecting it. Pursue only if Path 1 doesn't move the needle.

## Recommendation

Ship Path 1 + Path 2 together. Re-audit on "Better Image" after the
prompt change to confirm the planner produces more static shots and
the heuristic now fires on the expected ~60% of dialogue shots.
Path 3 stays parked unless the planner remains resistant to Path 1.

## Test plan

1. Apply Path 1 prompt edit.
2. Reset Better Image's scene_video_prompt nodes via `dhee_invalidate`.
3. Re-run planner; inspect new cameraWork prose.
4. Confirm:
   - Shots that should be static (purpose=show_dialogue, static beat)
     have NO motion verbs in cameraWork
   - Shots that genuinely need motion (reveals, dramatic beats) still
     have appropriate motion verbs
5. With Path 2 logs on, count how many of the 15 shots now qualify.
   Target: ≥ 7 shots skip LF (currently 3).

## References

- `src/core/planner/shotImagePipeline.ts` — `isHoldingBeat`,
  `stripLastFrameForHoldingBeat`, `HOLDING_BEAT_PURPOSES`,
  `CAMERA_MOTION_VERBS`
- `src/core/planner/ExecutorAgent.ts` — `applyHoldingBeatSkip`
  (the post-LLM hook)
- `prompts/skills/defaults/scene_breakdown_shot_guide.md` — likely
  source of the over-motion-verb prose
- Empirical evidence: `Better Image` project, scene 1 prompts at
  `prompts/videos/scenes/scene_1.json` (15-shot brief, 12/15 with
  unnecessary motion verbs as of 2026-05-22)
- Branch context: `skip-lf` (commits d8143ee, db25b5e, ef82f7d, 2f690d9)
- Related parked work: `todos/skip-wasted-last-frame-gen.md` (the
  original LF-skip idea, superseded by the in-pipeline heuristic but
  still useful as historical context)
