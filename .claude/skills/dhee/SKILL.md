---
name: dhee
version: 1.0.0
description: |
  Drive the dhee-core video pipeline from the shell. Use when the user asks to
  create a video from a story/idea, generate scenes/shots/images/videos for a
  dhee project, regenerate one piece of a project (a shot prompt, a scene's
  prose), override LLM-generated content with their own, or check the status
  of a running project. The pipeline goes: text input → scene breakdown →
  shot prompts → first/last frame images → video clips → final assembly.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# dhee-core CLI

A short reference for driving the dhee-core video pipeline. **Always run
commands from the dhee-core repo root** (where `package.json` lives). All
commands are `pnpm <verb> <project> ...`.

## When to use this skill

Invoke it when the user asks for any of these:

- "create a dhee project", "make a video from this story/idea"
- "regenerate shot N's prompt", "redo scene 3"
- "show me the prompt for shot 2", "what did the LLM generate for scene 1"
- "use my version of scene 3 instead of the one the LLM wrote"
- "what's the status of my project", "did anything fail"
- "run the pipeline", "stop after scene breakdown", "go to final video"

If the user is asking a code question (not asking to drive dhee), don't
invoke this skill — they probably want to edit source.

## Decision tree — what to run for what intent

Use this to translate fuzzy user requests into the right command.

| User says | What to run | Why |
|---|---|---|
| "make a video about X" / "create a dhee project" | `pnpm new` + `pnpm run-to` | bootstrap from scratch |
| "what's going on?" / "is it stuck?" | `pnpm status` first, then `pnpm inspect <node>` on anything failed | always probe before changing |
| "show me [thing]" | `pnpm inspect <project> <alias>` | reads the artifact + metadata |
| "do shot 2 next" / "I want to do shot by shot" | `pnpm run-to <project> shot_image:scene_N_shot_M` then `shot_video:scene_N_shot_M` | per-node gate pauses after that one |
| "this prompt is wrong, redo it" | `pnpm regen <node>` (no cascade — preview the redo) | regenerate without auto-cascading downstream |
| "change scene 2's plot — the rest must follow" | `pnpm override` then `pnpm regen <node> --cascade` | edit + cascade so dependents also redo |
| "I'll write this myself" | `pnpm override <project> <alias> --from <file>` | injects user content, marks node completed |
| "back up to <stage> and redo from there" | `pnpm reset <project> <stage>` | rolls state back; next `run-to` regenerates |
| "stop! I changed my mind" | `pnpm stop <project>` | clean cancel; safe to resume |
| "the structure is wrong / start over" | `pnpm reset <project> <stage> --clean` | wipes executorState entirely; graph rebuilds |

## Two-phase contract for cascading edits

When the user changes semantic content (prompt, scene prose, character
description), the cascade pattern is always the same:

```
1. inspect    — read the current content
2. override   — write the new content
3. regen --cascade  — invalidate this node + every downstream consumer
4. run-to     — re-execute from there
```

`override` alone marks the node `completed` but does NOT invalidate
downstream — that's intentional, so an agent can stage several edits
before kicking off cascades. `regen --cascade` is what triggers the
re-run wave.

## The 9 commands

```bash
# CREATE — --style and --duration are REQUIRED. Input via stdin (default), --text, or --input <file>.
pnpm new <project> --style <live|anime> --duration <sec> [--text "..." | --input <file>]
echo "story text" | pnpm new <project> --style live --duration 60      # stdin form

# INSPECT
pnpm status <project>                                    # phase + node rollup
pnpm nodes <project> [--type X] [--status Y] [--grep R]  # filtered list
pnpm inspect <project> <alias> [--full]                  # one node + its content

# DRIVE
pnpm run-to <project> [stage|node|alias] [--skip-media]  # run forward to a stage OR a specific node
pnpm reset <project> <stage> [--clean]                   # roll back to a stage
pnpm stop <project>                                      # cancel a running executor (drops .executor.stop)

# EDIT
pnpm regen <project> <alias> [--cascade] [--no-run]      # rerun one node
pnpm override <project> <alias> --from <file>            # inject user content
```

## Friendly aliases for `<alias>`

Any command that takes `<alias>` accepts either a verbatim node id
(`shot_image_prompt:scene_2_shot_3`) or a friendly form:

| Alias | Resolves to |
|---|---|
| `scene_2.scene` | `scene:scene_2` |
| `scene_2.svp` | `scene_video_prompt:scene_2` |
| `scene_2_shot_3.prompt` | `shot_image_prompt:scene_2_shot_3` |
| `scene_2_shot_3.image` | `shot_image:scene_2_shot_3` |
| `scene_2_shot_3.motion` | `shot_motion_directive:scene_2_shot_3` |
| `scene_2_shot_3.video` | `shot_video:scene_2_shot_3` |
| `elara` (bare) | `character:elara` (tries common typeIds in order) |

If a user says "shot 3 of scene 2" or "scene 2 shot 3", that's
`scene_2_shot_3.<thing>` where `<thing>` is what they want.

## Stages (for `run-to` and `reset`)

```
plot → story → characters → setting → scene → world_style →
character_image → setting_image → scene_video_prompt → shot_image_prompt →
shot_motion_directive → shot_image → shot_video → final_video
```

Common stops:
- `pnpm run-to myproj scene` — write scene prose, stop before shot planning
- `pnpm run-to myproj scene_video_prompt` — plan all shots, stop before any image
- `pnpm run-to myproj` — go all the way to the final video

`run-to` also accepts a **specific node id or alias** as the gate. The
executor pauses the moment that one node terminates, before its
siblings run. Drives the per-shot iteration loop:

- `pnpm run-to myproj shot_image:scene_1_shot_1` — generate just THAT image, then stop
- `pnpm run-to myproj scene_2_shot_3.image` — alias form, same idea
- `pnpm run-to myproj scene_2_shot_3.video` — render just one shot's video

## Common workflows

**Create from inline string (simplest — agents should use this form):**
```bash
pnpm new noir_60s --style live --duration 60 --text "A noir detective enters the rain..."
pnpm run-to noir_60s
```

**Create from stdin (good for multi-line input you'd build up programmatically):**
```bash
cat <<EOF | pnpm new my_anime --style anime --duration 30
A girl finds an ancient music box in her grandmother's attic.
The melody opens a door to another world.
EOF
pnpm run-to my_anime
```

**Create from a file (when the input is already on disk):**
```bash
pnpm new myproj --style live --duration 90 --input story.md
pnpm run-to myproj
```

**Style aliases** (resolved case-insensitively):
- `live` / `live-action` / `realism` / `realistic` / `cinematic` → `cinematic_realism`
- `anime` / `animation` / `animated` / `cartoon` / `2d` → `anime`

**Stop before any image is generated, then continue:**
```bash
pnpm new myproj --style live --duration 60 --text "..."
pnpm run-to myproj scene_video_prompt    # all prompts, no media
pnpm inspect myproj scene_2.svp          # check the LLM's plan
pnpm run-to myproj                        # continue to final video
```

**User wants to use their own scene 2 prose:**
```bash
pnpm run-to myproj scene                  # generate placeholder
# user writes their version to my_scene_2.md
pnpm override myproj scene_2.scene --from my_scene_2.md
pnpm regen myproj scene_2.scene --cascade   # cascade ensures downstream redoes
```

**Regenerate one shot's prompt only (LLM gave a bad one):**
```bash
pnpm regen myproj scene_2_shot_3.prompt --cascade
```

**Per-shot iteration — review one shot at a time, edit if needed, advance:**

This is the high-leverage "user wants control" workflow. For each shot in
the scene, generate just the image, pause for review, edit/regen if
needed, then generate just the video for that shot.

```bash
# 1. Generate just shot 1's image, pause
pnpm run-to myproj shot_image:scene_1_shot_1

# 2. Look at it: pnpm inspect myproj scene_1_shot_1.image
#    Don't like the framing? Edit the prompt and re-render the image:
pnpm inspect myproj scene_1_shot_1.prompt > /tmp/p.json
# (user / agent edits /tmp/p.json — change framing, lighting, etc.)
pnpm override myproj scene_1_shot_1.prompt --from /tmp/p.json
pnpm regen myproj scene_1_shot_1.image      # default = no cascade; just this image
# loop until happy with the image

# 3. Generate just shot 1's video
pnpm run-to myproj shot_video:scene_1_shot_1

# 4. Approve and advance to shot 2
pnpm run-to myproj shot_image:scene_1_shot_2
# ...repeat
```

The default behavior of `regen` is "no cascade" — useful here so editing
shot 1's prompt re-renders only its image, not its video (you'll do
that explicitly in step 3). When the user is changing semantics that
SHOULD propagate, add `--cascade`.

**Cancel a running executor without killing the terminal:**
```bash
# In one terminal: pnpm run-to myproj
# In another: signal the running executor to stop cleanly
pnpm stop myproj
```

`stop` drops `.executor.stop` in the project dir; the running executor
notices on its next tick (~250ms), interrupts any in-flight ComfyUI
work, and exits with stopReason='cancelled'. State is persisted; safe
to resume with another `pnpm run-to`.

**Something failed — debug:**
```bash
pnpm status myproj                        # shows failed nodes + errors
pnpm inspect myproj <failed-node>         # see context
pnpm regen myproj <failed-node>           # retry just that one
```

**Restructure changed and per-item nodes are stale (rare but happens after
big LLM-driven structure changes):**
```bash
pnpm reset myproj scene_video_prompt --clean
# --clean wipes executorState entirely so the graph rebuilds from scratch
```

## What lives where in the project folder

```
<project>.dhee/
├── original_input.md              # user's story or idea
├── project.json                   # full state (phases + executorState)
├── chapters/chapter_1/
│   ├── plans/{plot,story}.md      # high-level plans (skipped if input=story)
│   └── scenes/scene_N.md          # per-scene prose
├── characters/<name>.md           # character profiles
├── settings/<name>.md             # location profiles
├── prompts/
│   ├── scene_summaries.json       # extracted summaries (P0 path)
│   ├── scene_durations.json       # per-scene budgets (duration-first path)
│   ├── videos/scenes/scene_N.json # scene_video_prompt outputs (the "shot plan")
│   ├── images/shots/scene-N-shot-M.json    # shot_image_prompt outputs
│   └── motion/scene_N_shot_M.json          # shot_motion_directive outputs
└── assets/
    ├── images/                    # generated reference + per-shot frames
    └── videos/{shots,final}/      # per-shot clips + final assembly
```

## Tips

- **Always start with `pnpm status`** when joining a project. It tells you
  the phase, what's pending, and any failures in seconds.
- **Use `inspect` before `regen`.** Read what the LLM produced first; sometimes
  you'll just want to `override` it instead of asking another LLM call.
- **`--cascade` on regen is the default mental model** when the user is
  changing semantics, not just retrying a transient failure.
- **Don't edit project.json by hand.** Use `override` (which writes the
  outputPath file AND updates state atomically). Hand-edits drift from the
  graph and cause subtle bugs.
- **Logs:** `logs/llm-calls-truncated.log` is the most useful when something
  went wrong inside an LLM call. `logs/debug.log` for ComfyUI cloud activity.
  Per-project: `<project>.dhee/logs/executor.log`.

## What this skill does NOT cover

- Editing prompt templates in `prompts/skills/defaults/` — that's source-code
  work, not pipeline driving.
- Modifying the executor / planner / extractor source. The CLI sits on top
  of those; for changes inside, work in `src/core/planner/`.
- Live UI session in `pnpm start`. The CLI is the headless equivalent.
