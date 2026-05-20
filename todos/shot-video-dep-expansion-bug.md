# `shot_video` dep-graph expansion bug

## Symptom

In a fresh full-pipeline run on `sun_hadnt_yet_cleared-2` (Parvati story, 60s, deepseek + prompt-relay) the executor fired `shot_video:scene_X_shot_1` early — *before* the corresponding `shot_image:scene_X_shot_1` had been generated — for all four scenes. The per-shot prompt-relay bundle then failed with:

```
prompt_relay: scene 1 shot 1 has no first_frame yet — bundle waits
prompt_relay bundle render failed; falling back to per-shot for shot_video:scene_1_shot_1
No shot image found for shot_video:scene_1_shot_1
```

Inspecting the runtime graph state (`project.json.executorState.nodes`), each per-item `shot_video` node had wrong deps:

```jsonc
"shot_video:scene_1_shot_1": {
  "dependencies": [
    // ALL 15 of scene 1's motion directives — should be only shot_1's
    "shot_motion_directive:scene_1_shot_1",
    "shot_motion_directive:scene_1_shot_2",
    ...
    "shot_motion_directive:scene_1_shot_15"
    // shot_image:scene_1_shot_1 — MISSING ENTIRELY
  ],
  "dependents": ["final_video", "final_video", "final_video", "final_video"]  // 4× duplicates too
}
```

## Why the existing template / per-item rewire didn't catch it

The template (`src/templates/narrative.ts`) correctly declares `shot_video` deps:

```ts
{ artifactTypeId: 'shot_image', required: true, scope: 'matching' },
{ artifactTypeId: 'shot_motion_directive', required: true, scope: 'matching' }
```

So expansion should rewire `shot_image` / `shot_motion_directive` to the matching per-item refs (`shot_image:scene_1_shot_1`, `shot_motion_directive:scene_1_shot_1`). Instead, the runtime ended up with all of scene 1's motion directives and zero shot_image dep.

I suspect the bug is in `DependencyGraphExecutor.expandMatchingDependent` (`src/core/planner/DependencyGraphExecutor.ts:498-604`) interacting badly with `expandCollection` when:

1. `shot_video` is first expanded scene-by-scene (`shot_video:scene_1`, `shot_video:scene_2`, ...) via `expandCollection('shot_video', sceneItems)`.
2. Then `shot_motion_directive:scene_1` gets per-shot-expanded into 15 items via cascade.
3. `expandMatchingDependent` is called on `shot_video:scene_1` (still a collection at the scene level), creating per-shot `shot_video:scene_1_shot_*` nodes.
4. The `preRewire` step at line 520 inherits the scene-level node's dependencies (which already include all of scene 1's per-shot motion directives because step 2 ran first). So all per-shot shot_video clones inherit ALL scene-1 motion directives.

`rewireMatchingDepsForItem` (line 352) only rewires bare type-level refs to per-item; it leaves already-per-item refs alone. So once the wrong per-item refs are in the dep list, they stay.

## Defensive fix shipped

`src/core/planner/shotVideoCanonicalDeps.ts` (with 9 tests in `tests/unit/shotVideoCanonicalDeps.test.ts`) — exposes `sanitizeShotVideoDeps` which rebuilds a shot_video node's deps from the canonical triple `[shotImageId, motionId, prevShotVideoId?]` and strips stray per-item refs for shot_image / shot_motion_directive that don't match this shot.

`expandSceneBreakdownGraph` (`ExecutorAgent.ts:1393`-area) calls `sanitizeShotVideoDeps` in the existing-node else branch. So whenever materialization runs after expansion, deps are guaranteed correct regardless of how expansion mangled them.

This unblocks pipeline runs but leaves the underlying expansion bug intact. A `shot_video` node that's never re-materialized (e.g. created on a fresh run that doesn't trigger another scene materialization) could still ship with bad deps.

## Real fix to do

Investigate `expandMatchingDependent` lines 514-555 — specifically the `preRewire` snapshot at line 520. When the dependent (`shot_video:scene_1`) is itself a collection that gets per-shot-expanded, the per-shot clones inherit the parent's already-per-item deps without filtering them down to just-this-shot.

Possible fix: when creating per-shot clones from a collection-level dependent, drop deps of types that have themselves been per-item-expanded for OTHER items, then add the matching per-item ref for THIS item.

Or even cleaner: when `expandMatchingDependent` builds `preRewire` for each item, filter out per-item deps whose itemId doesn't match the item being created.

```ts
const preRewire = dependent.dependencies.filter(d => {
  // Drop self-typeId
  if (d === dependent.typeId) return false;
  // Drop per-item refs whose itemId doesn't match this item
  if (d.includes(':')) {
    const [, depItemId] = d.split(':', 2);
    if (depItemId && depItemId !== item.itemId) return false;
  }
  return true;
});
```

This needs care — some per-item deps might legitimately reference a DIFFERENT item (e.g. `prevShotVideoId` is shot_(N-1) for shot_N). So the filter would need to know which dep types are "matching scope" vs "any other scope" before stripping.

## Validation after the real fix

```
pnpm reset sun_hadnt_yet_cleared-2 scene
pnpm run-to sun_hadnt_yet_cleared-2 shot_video:scene_1_shot_1
```

Then inspect:

```
jq '.executorState.nodes."shot_video:scene_1_shot_1".dependencies' \
  sun_hadnt_yet_cleared-2.dhee/project.json
```

Expected: `["shot_image:scene_1_shot_1", "shot_motion_directive:scene_1_shot_1"]` (plus optional prev-shot-video ref). Anything else = bug still present.

## Files

- `src/core/planner/DependencyGraphExecutor.ts:498-604` — `expandMatchingDependent`
- `src/core/planner/DependencyGraphExecutor.ts:352-395` — `rewireMatchingDepsForItem`
- `src/core/planner/ExecutorAgent.ts:1393`-area — `expandSceneBreakdownGraph` (where the defensive fix lives now)
- `src/core/planner/shotVideoCanonicalDeps.ts` — the sanitize helper

## Out of scope

- TTS / Phase 6 narration audio — separate todo.
- The stale dependents array (`final_video, final_video, final_video, final_video` 4× duplicates) — same root cause; once dep edges are wired correctly, the dependents arrays should be too.
