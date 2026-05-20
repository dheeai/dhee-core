# dhee-Core Pipeline Architecture: Plot → Final Video

## Overview

The pipeline is a **dependency-graph executor** where an LLM generates content (stochastic) and deterministic code handles all I/O, media generation, and assembly. The executor walks nodes in topological order — a node runs only when all its dependencies are complete.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DEPENDENCY GRAPH EXECUTOR                       │
│                                                                     │
│  Walks nodes in topological order. Each node is either:             │
│    🎲 STOCHASTIC — LLM generates content (text/JSON)               │
│    ⚙️  DETERMINISTIC — Code processes media (images/video/assembly) │
│                                                                     │
│  Collections expand dynamically as upstream nodes complete.         │
│  The graph grows during execution (story → characters → images).   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Full Pipeline Graph

```
                              USER INPUT (story text or prompt)
                                        │
                                        ▼
                                 ┌─────────────┐
                            🎲   │    plot      │  LLM writes a structured plot outline
                                 └──────┬──────┘
                                        │
                                        ▼
                                 ┌─────────────┐
                            🎲   │    story     │  LLM expands plot into full screenplay
                                 └──────┬──────┘
                                        │
                      ┌─────────────────┼─────────────────┐
                      │                 │                 │
                      ▼                 ▼                 ▼
              ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
         🎲   │  character   │  │   setting    │  │    scene     │  ◄── COLLECTIONS
              │  (per char)  │  │ (per setting)│  │  (per scene) │      extracted from
              └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      story by LLM
                     │                 │                 │
                     ▼                 ▼                 │
              ┌──────────────┐  ┌──────────────┐         │
         🎲   │ world_style  │◄─┤              │         │
              │              │  │  (all scenes  │         │
              └──────┬───────┘  │  + settings)  │         │
                     │          └──────────────┘         │
         ┌───────────┼───────────────────────────────────┘
         │           │           │
         ▼           ▼           ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │character_image│ │setting_image │ │ object_image │
  │  (per char)  │ │(per setting) │ │ (per object) │    ◄── ⚙️ DETERMINISTIC
  │              │ │              │ │              │        Image gen via ComfyUI
  │  FLUX Klein  │ │  FLUX Klein  │ │  FLUX Klein  │        (from LLM text prompt)
  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
         │                │                │
         └────────────────┼────────────────┘
                          │
                          ▼
                 ┌─────────────────┐
            🎲   │scene_video_prompt│  LLM breaks each scene into shots (JSON)
                 │   (per scene)   │  {shotNumber, cameraWork, purpose, duration}
                 └────────┬────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
     ┌─────────────────┐    ┌─────────────────────┐
🎲   │shot_image_prompt │    │shot_motion_directive │  🎲
     │   (per shot)     │    │    (per shot)        │
     │                  │    │                      │
     │ JSON: frames,    │    │ LTX-optimized motion │
     │ generationMode,  │    │ prompt for video gen │
     │ references       │    │                      │
     └────────┬─────────┘    └──────────┬───────────┘
              │                         │
              ▼                         │
     ┌─────────────────┐               │
⚙️   │   shot_image     │               │
     │   (per shot)     │               │
     │                  │               │
     │ Generates first_ │               │
     │ frame, last_frame│               │
     │ (± mid_frame)    │               │
     └────────┬─────────┘               │
              │                         │
              └────────────┬────────────┘
                           │
                           ▼
                  ┌─────────────────┐
             ⚙️   │   shot_video     │
                  │   (per shot)     │
                  │                  │
                  │ LTX-2.3 video   │
                  │ generation      │
                  │ (flfv / v2v)    │
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
             ⚙️   │  final_video     │  FFmpeg concat + xfade transitions
                  │                  │
                  └──────────────────┘
```

---

## Node Reference

### 🎲 Stochastic Nodes (LLM-generated)

| Node | Input | Output | What it does |
|------|-------|--------|-------------|
| **plot** | User prompt | `plans/plot.md` | Structures the narrative: acts, beats, character arcs, pacing |
| **story** | plot | `plans/story.md` | Full screenplay with dialogue, scene descriptions, stage directions |
| **character** | story | `characters/{name}.md` | Physical description, personality, distinctive features for one character |
| **setting** | story | `settings/{name}.md` | Location details: architecture, lighting, atmosphere, key objects |
| **object** | story | `objects/{name}.md` | Notable props: weapons, artifacts, vehicles — visual description |
| **scene** | story + all characters/settings | `scenes/scene_{n}.md` | Detailed scene narrative with character actions, dialogue, emotional beats |
| **world_style** | story + all scenes/settings | `plans/world_style.md` | Visual style guide: color palette, lighting language, art direction |
| **scene_video_prompt** | scene + world_style | `prompts/videos/scenes/scene_{n}.json` | Breaks scene into shots: `{shotNumber, shotType, cameraWork, purpose, duration, characters}` |
| **shot_image_prompt** | scene_video_prompt + world_style + ref images | `prompts/images/shots/scene-{n}-shot-{m}.json` | Per-frame image generation instructions (see Frame Generation below) |
| **shot_motion_directive** | scene_video_prompt + shot_image_prompt | `prompts/motion/scene-{n}-shot-{m}.txt` | LTX-optimized motion prompt describing camera movement and action |

### ⚙️ Deterministic Nodes (code-driven media generation)

| Node | Input | Output | What it does |
|------|-------|--------|-------------|
| **character_image** | character text + world_style | `assets/images/characters/{name}.png` | FLUX Klein generates a reference portrait from the text description |
| **setting_image** | setting text + world_style | `assets/images/settings/{name}.png` | FLUX Klein generates an environment reference image |
| **object_image** | object text + world_style | `assets/images/objects/{name}.png` | FLUX Klein generates a prop/object reference image |
| **shot_image** | shot_image_prompt JSON + ref images | `assets/images/shots/` (first_frame, last_frame, ±mid_frame) | Generates keyframe images for video interpolation (see Frame Generation) |
| **shot_video** | shot_image + motion_directive + ±previous_video | `assets/videos/shots/scene_{n}_shot_{m}.mp4` | LTX-2.3 generates a video clip from keyframes + motion prompt |
| **final_video** | all shot_videos | `assets/videos/final/{name}.mp4` | FFmpeg concatenates all clips with xfade transitions |

---

## Collection Expansion

Collections are type-level placeholders that expand into per-item nodes as upstream content completes. The graph grows dynamically during execution.

```
story completes
  │
  ├─→ LLM extracts: characters=[alice, bob], settings=[forest, castle], scenes=[1,2,3]
  │
  ├─→ character (collection) ──expands──→ character:alice, character:bob
  ├─→ setting (collection)   ──expands──→ setting:forest, setting:castle
  └─→ scene (collection)     ──expands──→ scene:scene_1, scene:scene_2, scene:scene_3

scene_video_prompt:scene_1 completes
  │
  ├─→ JSON parsed: shots=[{shotNumber:1}, {shotNumber:2}, {shotNumber:3}]
  │
  ├─→ shot_image_prompt:scene_1 ──expands──→ shot_image_prompt:scene_1_shot_1, ...
  ├─→ shot_motion_directive:scene_1 ──expands──→ shot_motion_directive:scene_1_shot_1, ...
  ├─→ shot_image:scene_1 ──expands──→ shot_image:scene_1_shot_1, ...
  └─→ shot_video:scene_1 ──expands──→ shot_video:scene_1_shot_1, ...
```

---

## Frame Generation: shot_image

The `shot_image_prompt` JSON tells the executor how to generate each keyframe image.

### Generation Strategies

| Strategy | Frames generated | Use case |
|----------|-----------------|----------|
| **flfv** | first_frame + last_frame | Default — simple motion, dialogue, action |
| **fmlfv** | first_frame + mid_frame + last_frame | Complex transformations, VFX, morphing |

### Frame Generation Modes (LLM decides per-frame)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FIRST FRAME MODES                               │
│                                                                         │
│  image_text_to_image                                                    │
│  ├── Uses: character/setting/object reference images + text prompt      │
│  ├── "from image N" references character/setting refs                   │
│  ├── Best for: first shot of scene, dramatic reframing, new composition│
│  └── Generates completely fresh image                                   │
│                                                                         │
│  edit_previous_shot                                                     │
│  ├── Uses: previous shot's LAST FRAME as base image                    │
│  ├── + reference images for NEW characters being introduced            │
│  ├── "from image N" only for NEW elements, existing subjects by name   │
│  ├── Best for: same subjects, similar angle, continuous action         │
│  ├── Maintains visual continuity (lighting, colors, character look)    │
│  └── FLUX Klein edits the base image per the change description        │
│                                                                         │
│  text_to_image                                                          │
│  ├── Uses: text prompt only, no reference images                       │
│  ├── Best for: abstract shots, extreme close-ups on details            │
│  └── No character/setting consistency guarantees                       │
├─────────────────────────────────────────────────────────────────────────┤
│                     LAST FRAME / MID FRAME MODE                         │
│                                                                         │
│  edit_first_frame                                                       │
│  ├── Uses: this shot's FIRST FRAME as base image                       │
│  ├── NO reference images, NO "from image N"                            │
│  ├── Describes ONLY what changed (delta from first frame)              │
│  ├── Must be DRAMATICALLY different (3-5 seconds of change)            │
│  └── FLUX Klein edits to show end state                                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Decision Flow (LLM chooses, executor executes)

```
Is this shot_1 of the scene?
  ├── YES → image_text_to_image (fresh, with all character/setting refs)
  └── NO  → How different is this shot from the previous?
              ├── Similar subjects + angle → edit_previous_shot
              │     ├── New character entering? → include ref in references[]
              │     │     → "The phantom from image 1 appears beside the girl"
              │     └── Same characters? → references[] empty
              │           → "The girl has moved to the right edge of the frame"
              └── Dramatic change → image_text_to_image
                    (new composition, extreme reframing, new location feel)
```

---

## Video Generation: shot_video

### Strategy Decision (deterministic, code-driven)

```python
getVideoStrategy(itemId, purpose):
  if itemId == 'scene_1_shot_1':     return 'flfv'   # First shot ever
  if purpose in FRESH_PURPOSES:       return 'flfv'   # New visual content
  else:                               return 'v2v_extend'  # Continue previous

FRESH_PURPOSES = {
  'set_the_world',    # New environment establishing shot
  'show_change',      # Dramatic visual transformation
  'meet_character',   # Character not in previous frames
  'set_the_mood',     # New composition/atmosphere
  'show_clue',        # Focus on new visual element
}
```

### Video Generation Paths

```
┌────────────────────────────────────────────────────────────┐
│  flfv / fmlfv (fresh generation)                           │
│                                                            │
│  Inputs:                                                   │
│    sourceImagePath  = shot's first_frame.png               │
│    frameImages      = {last_frame.png, ±mid_frame.png}     │
│    prompt           = motion directive text                 │
│    durationSeconds  = from scene_video_prompt               │
│                                                            │
│  LTX-2.3 interpolates between keyframe images              │
│  guided by the motion prompt.                              │
├────────────────────────────────────────────────────────────┤
│  v2v_extend (continuation)                                 │
│                                                            │
│  Inputs:                                                   │
│    sourceImagePath  = shot's first_frame.png               │
│    sourceVideoPath  = previous shot's video.mp4            │
│    frameImages      = {last_frame.png, ±mid_frame.png}     │
│    prompt           = motion directive text                 │
│    durationSeconds  = from scene_video_prompt               │
│                                                            │
│  LTX-2.3 extends the previous video, guided by the        │
│  new keyframes and motion prompt. Maintains motion         │
│  continuity from the previous clip.                        │
└────────────────────────────────────────────────────────────┘
```

### Cross-Shot Video Chaining

```
shot_1 video ──────────────────┐
                               │ sourceVideoPath
shot_2 video ◄─────────────────┘
  │
  │ sourceVideoPath
  ▼
shot_3 video ◄─────────────────┘
  │
  ... (within same scene)

Cross-scene: scene_2_shot_1 can extend from scene_1's LAST shot video
```

---

## Final Assembly

```
shot_video:scene_1_shot_1.mp4  ─┐
shot_video:scene_1_shot_2.mp4  ─┤
shot_video:scene_1_shot_3.mp4  ─┤
shot_video:scene_2_shot_1.mp4  ─┤    FFmpeg concat filter
shot_video:scene_2_shot_2.mp4  ─┼──► [v0][a0][v1][a1]...[vN][aN]
shot_video:scene_2_shot_3.mp4  ─┤    concat=n=N:v=1:a=1
...                             ─┤    + xfade transitions
shot_video:scene_4_shot_3.mp4  ─┘    (cut, fade, dip_to_black, wipe)
                                              │
                                              ▼
                                      final_video.mp4
```

---

## Scene State Tracking

Each shot tracks character positions and scene changes to keep the narrative consistent.

```
Before shot_image_prompt generation:

  ┌─ Load previous state ──────────────────────────────────┐
  │  scene_1 state after shot 2:                           │
  │    characters: [{name: "girl", position: "center",     │
  │                  facing: "camera", expression: "fear"}] │
  │    setting: "apocalyptic_city"                         │
  │    lighting: "warm golden from overhead fires"         │
  └────────────────────────────────────────────────────────┘
          │
          ▼ LLM reads shot_3 description
  ┌─ Compute target state ─────────────────────────────────┐
  │  CHANGES for shot 3:                                   │
  │    girl: position "center" → "far right edge"          │
  │    girl: expression "fear" → "determined"              │
  │    NEW: phantom appears at "center"                    │
  └────────────────────────────────────────────────────────┘
          │
          ▼ Injected into shot_image_prompt context
  ┌─ <last_frame_changes> ─────────────────────────────────┐
  │  These changes MUST be visible in the last frame:      │
  │  - girl moved from center to far right edge            │
  │  - girl expression changed from fear to determined     │
  │  - phantom appeared at center                          │
  └────────────────────────────────────────────────────────┘
```

---

## Execution Modes

| Mode | Behavior | Use case |
|------|----------|----------|
| **Serial** (default) | All content nodes finish → then all image nodes → then all video nodes | Predictable, low memory, clear progress |
| **Parallel** | Content + media run concurrently when dependencies allow | Fast when LLM and ComfyUI are on separate servers |

---

## Error Recovery

```
Node fails
  │
  ├── Transient error (timeout, connection) → retry once
  │
  ├── Corrupt JSON output → invalidate node, regenerate on next loop
  │
  ├── Missing dependency output (file deleted) → regenerate dependency
  │
  └── Stuck (no ready nodes, no progress) → structural repair
        ├── Rebuild missing nodes (max 2 attempts)
        └── If still stuck → fail with diagnostic
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/templates/narrative.ts` | Artifact type definitions, dependency declarations |
| `src/core/planner/DependencyGraphExecutor.ts` | Graph traversal, node expansion, status tracking |
| `src/core/planner/ExecutorAgent.ts` | Main loop, LLM calls, media dispatch, collection expansion |
| `src/core/planner/crossShotChaining.ts` | `edit_previous_shot`, `v2v_extend`, `buildEditPrompt` |
| `src/core/planner/shotReferenceMapping.ts` | Available refs, purpose filtering, shot context hints |
| `src/core/planner/sceneState.ts` | Character/setting state tracking per shot |
| `src/core/planner/schemas.ts` | Zod schemas for JSON validation |
| `src/core/planner/collectionExtractor.ts` | Extract characters/settings/scenes from content |
| `src/core/timeline/FFmpegAssembler.ts` | FFmpeg concat + xfade for final assembly |
| `src/services/providers/comfyui/ComfyUIProvider.ts` | FLUX Klein image gen/edit, LTX-2.3 video gen |
| `prompts/skills/defaults/shot_composition_guide.md` | LLM guide for shot_image_prompt generation |
