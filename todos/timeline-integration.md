# Timeline.json Integration

## Problem

The dependency graph executor (`feature/dep-graph` branch) bypasses the timeline system entirely. The `executeFinalAssembly` method builds resolved segments directly from shot video nodes without creating or updating `timeline.json`. The agentic flow (in `backward-flow` / `master` branch) maintained a proper timeline with segments, layers, transitions, and compositing metadata.

The dhee desktop app depends on `timeline.json` as the interface between the generation backend and the visual editor. Without it, the desktop app has no structured data to display or edit.

## What Was Lost

- `timeline.json` creation and updates during execution
- Timeline segments with proper start/end times, labels, layers
- Timeline validation (gaps, fill status)
- Timeline-based assembly (used `resolveSegmentFilePaths` from timeline)
- Segment-level transitions (now stored in scene_video_prompt JSON but not in timeline)
- Global layers (narration audio, background music)
- Layer history / versioning
- The `assemble_from_timeline` tool (replaced by deterministic `executeFinalAssembly`)

## What Needs to Happen

1. **Restore timeline.json creation** — after shot videos are generated, build a proper timeline with segments mapped to shot videos, transitions from scene_video_prompt, and layers
2. **Keep the deterministic executor** — don't go back to agentic navigation, but have the executor update the timeline as it progresses
3. **Assembly from timeline** — `executeFinalAssembly` should build/update `timeline.json` first, then assemble from it (not directly from nodes)
4. **Transition data flows** — transitions defined in scene_video_prompt should propagate through timeline segments to the assembler
5. **Desktop app compatibility** — timeline.json must match the schema the desktop app expects

## Key Files

- `src/core/timeline/types.ts` — Timeline, TimelineSegment, SegmentTransition types (still exist)
- `src/core/timeline/TimelineManager.ts` — createTimelineSkeleton, loadTimeline, saveTimeline (still exist)
- `src/core/timeline/FFmpegAssembler.ts` — resolveSegmentFilePaths, assembleVideos (still exist)
- `src/core/planner/ExecutorAgent.ts` — executeFinalAssembly (bypasses timeline)
- `src/core/timeline/TimelineTools.ts` — assemble_from_timeline tool (unused in executor path)

## Priority

High — blocks desktop app integration.

## Reference

Check `master` or `backward-flow` branch for the working timeline integration, specifically:
- How the agent updated timeline segments after each shot video
- How `assemble_from_timeline` read the timeline and called `assembleVideos`
- The timeline.json schema the desktop app expects
