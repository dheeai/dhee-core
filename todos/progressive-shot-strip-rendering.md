# Progressive shot-strip rendering on the desktop timeline

## Goal

As shots are generated, each timeline slot in the dhee-desktop
Timeline panel should progressively display the best available content
for that shot — automatically upgrading as higher-tier assets land on
disk.

Today every shot slot is a placeholder strip showing only the label
("Shot 1: shot_1"), regardless of what's been generated.

## Render priority (highest → lowest)

1. **shot video** (mp4)
2. **shot first-frame + last-frame images** (split block, FF left / LF right)
3. **shot first-frame image only**
4. **shot image-prompt + shot video-prompt** (stacked text)
5. **shot image-prompt only** (text)
6. **shot id** ("Scene 1 Shot 1") — current behavior
7. nothing

The watcher already debounces `timeline.json` reloads at 250ms, so a
strip will auto-upgrade tier the moment dhee-core writes a new path
in.

## Two-repo work

This is **not** doable in either repo alone — `timeline.json` doesn't
expose the fields the renderer needs.

### dhee-core — extend `timeline.json` writer

Today each timeline item carries a single `prompt` and a `videoPath` /
`imagePath`. Need to add per-shot:

- `firstFramePath`
- `lastFramePath`
- `videoPath` (already there for `type: 'video'`)
- `imagePrompt`
- `videoPrompt` (split from the conflated `prompt` field)

These all already exist in core's project state — the writer just
isn't surfacing them. Producer lives near `TimelineManager` /
`createTimelineSkeleton`; check current writer for shot mapping.

Existing projects: re-emit `timeline.json` on next executor run so
they pick up the new fields. No on-disk migration needed.

### dhee-desktop

- Extend `TimelineItem` interface in
  `src/renderer/hooks/useTimelineData.ts` (~lines 22–57) with the new
  optional fields above.
- Update `TimelineItemComponent` in
  `src/renderer/components/preview/TimelinePanel/TimelinePanel.tsx`
  (~lines 237–745) to pick the highest-tier renderer per the priority
  list. The tier resolver should be a small pure function, easy to
  unit-test.
- Reuse `resolveAssetPathForDisplay` from
  `src/renderer/utils/pathResolver.ts` for FF/LF/video paths.

## Open questions to resolve before starting

1. **FF + LF visual** — 50/50 horizontal split inside the strip (FF
   left, LF right) feels natural; alternatives are stacked, or FF
   background with LF inset. Default to 50/50 split unless we have a
   reason to do otherwise.
2. **Prompt rendering at small zoom levels** — at 100% zoom a
   3.2-second strip is wide enough to show two short prompt lines, but
   below ~50% zoom text becomes useless. Define a min-pixel-width
   below which we fall back to label-only (tier 6) regardless of
   higher-tier data being available.
3. **Label as bottom overlay** — when showing video / images, keep the
   shot label as a subtle bottom-bar overlay so the user can still
   identify the slot. Confirm this matches the desired look.

## Why parked

Spans both repos and isn't blocking the embed-for-desktop PR. Picked
up after the embed branch lands and the timeline.json schema
extension can ride in alongside other writer changes.

## Related todos

- `timeline-integration.md` — restoring timeline.json from the
  dep-graph executor; this todo assumes that work is complete.
- `fix-timeline-reset-and-load.md` — adjacent timeline plumbing.
