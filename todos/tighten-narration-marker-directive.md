# Tighten narration-marker directive for `pervasive` mode

## Context

The story-essence narration feature shipped on `feature/pi-agent-prompt-relay` (April 2026) — `StoryEssence.narration` carries `mode: 'none' | 'minimal' | 'pervasive'` and a voice description, threaded into per-scene prose generation via `buildStoryEssenceBlock` (`src/core/planner/storyEssenceContextBlock.ts`).

When tested on `sun_hadnt_yet_cleared-2` (Parvati & Isha, narration.mode = `pervasive`), the model produced **only 1 explicit `**NARRATION (V.O.):**` block** across 3 scenes — at exactly the right moment in scene 1. But scenes 2 and 3 carry equally narration-worthy interior content as third-person prose without the marker:

- Scene 2: *"She thinks of the shoes. Five thousand rupees. Two months of extra shifts... A necessary, beautiful lie."*
- Scene 3: *"A memory flickers: a skipped dinner, two nights ago... The hunger was a familiar companion."*
- Scene 3: *"These are not the hands of a young woman. These are the hands of a woman who has aged decades in a few short years."*

These are exactly the interior thoughts / memories / omniscient observations that should be voiced by a narrator in pervasive mode. The model wrote them correctly as prose but didn't flag them with the V.O. marker downstream tooling needs.

## Why this matters

A future TTS pipeline (Phase 6 on the essence-aware-downstream roadmap, see `todos/essence-aware-downstream-prompts.md`) will extract `**NARRATION (V.O.):**` blocks → synthesize audio → mix as voice-over in the final video. With 1 block instead of 4–5, only the hand-fall moment in scene 1 gets a narrator's voice; the rest of the interior content sits as silent prose direction.

Right now this isn't blocking — the prose contains all the right content, it just isn't formatted for extraction. But the moment we wire TTS, this becomes the bottleneck: the LLM's editorial restraint about marking blocks is starving the audio layer of the very content it's supposed to carry.

## What to change

In `src/core/planner/storyEssenceContextBlock.ts`, `buildNarrationDirective` for `mode === 'pervasive'` should be more explicit about WHAT qualifies as a marker block. Two concrete tweaks:

1. **Add a "candidate phrases" hint**: tell the model that phrasings like *"she had told her daughter..."*, *"she remembered..."*, *"the hunger was a familiar companion"*, *"these were not the hands of..."* are the exact triggers for V.O. blocks — interior thought, retrospective context, omniscient observation.

2. **Make the format mandatory for pervasive mode**: change "earns its place" to "for `pervasive` mode, every interior thought / memory / omniscient observation MUST be wrapped as `**NARRATION (V.O.):**`. Do not write interior content as third-person prose direction in pervasive mode — that hides it from the audio pipeline."

For `minimal` mode, keep current restraint — the directive already says "sparingly" and the model interprets it correctly.

## Validation

After the prompt tweak:

```
pnpm reset sun_hadnt_yet_cleared-2 scene
pnpm run-to sun_hadnt_yet_cleared-2 scene
grep -c "NARRATION (V.O." sun_hadnt_yet_cleared-2.dhee/chapters/chapter_1/scenes/scene_*.md
```

Expect ≥3 narration blocks total across the 3 scenes (vs the current 1). Spot-check that the new blocks correspond to interior content (not duplicating what dialogue or visuals already carry).

## Cross-genre check

Re-run `pnpm tsx scripts/probe-story-essence.ts lazarus_drive --duration 60` (which previously chose `minimal`) and verify the tightened pervasive directive doesn't bleed into minimal-mode prose generation. The minimal-mode directive should remain sparing.

## Files to touch

- `src/core/planner/storyEssenceContextBlock.ts` — `buildNarrationDirective` (only the pervasive branch).
- `tests/unit/storyEssenceContextBlock.test.ts` — new assertion that the pervasive directive contains "must" / "every interior" language and a candidate-phrase hint.

## Out of scope

- TTS pipeline itself — separate effort (Phase 6).
- Re-tuning minimal mode — current behavior is correct.
- Schema changes to StoryEssence — narration shape is already correct.
