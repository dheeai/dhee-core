---
name: dhee
version: 2.0.0
description: |
  Drive the dhee-core video pipeline from the shell via `pnpm dhee <verb>`.
  Use when the user asks to create a video from a story/idea, run the
  pipeline (or stop at a stage), inspect/regenerate/override one node of a
  project, or check status. The pipeline goes: story → essence → world
  style → characters → settings → scenes → shot prompts → shot images →
  motion → scene video prompts → scene clips → final assembly.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# dhee-core CLI (`pnpm dhee`)

A reference for driving the dhee-core **bundle pipeline** headlessly.
**Always run from the dhee-core repo root** (where `package.json` lives).
Every command is `pnpm dhee <verb> ...`.

> This CLI (`scripts/dhee-cli.ts`) is a thin wrapper that calls the exact
> same code the desktop chat agent uses — `initializeProject` +
> `runProjectViaBundle` + the `dhee_*` pi-agent tools. So driving via the
> CLI is functionally identical to driving via the app, just headless.

## When to use this skill

- "create a dhee project", "make a video from this story/idea"
- "run the pipeline", "stop after scenes", "go to final video"
- "regenerate shot 3's image", "redo the world style"
- "show me the scene plan", "what did the LLM generate for the shots"
- "use my version of the plot instead of the LLM's"
- "what's the status", "did anything fail", "stop the run"

If the user is asking a **code** question (not asking to drive a render),
don't invoke this skill — they want to edit source.

## The verbs

```bash
# CREATE — story via --story <file>, --text "...", or stdin. Bundle defaults
# to narrative_prompt_relay. Project lands in ~/dhee-studios/<name>
# (override with $dhee_PROJECTS_DIR or --dir <abs>).
pnpm dhee new <name> --story <file> [--style live|anime] \
    [--aspect 16:9|9:16] [--resolution 720|1080] [--duration <sec>] \
    [--bundle <id>] [--style-guide <file>]
echo "story text" | pnpm dhee new <name> --style anime --duration 30   # stdin form

# INSPECT (read-only)
pnpm dhee status <project>                       # node status counts + failures
pnpm dhee nodes  <project> [--status <s>] [--grep <r>]   # list walkState nodes
pnpm dhee inspect <project> <nodeId> [--item <itemId>]   # read a node's output
pnpm dhee bundles                                # list available pipelines

# DRIVE
pnpm dhee run    <project> [--to <nodeId>] [--only <id,id>]   # run forward
pnpm dhee run-to <project> [<nodeId>]            # same, gate passed positionally
pnpm dhee stop   <project>                       # signal a running `run` to halt

# EDIT
pnpm dhee regen    <project> <nodeId> [--item <itemId>]      # invalidate + re-run (cascades)
pnpm dhee override <project> <nodeId> --from <file> [--item <itemId>] [--reason "..."] [--confirm]
```

`<project>` is a **name** (resolved under `$dhee_PROJECTS_DIR`, else
`~/dhee-studios/<name>`, else cwd / `<name>.dhee`) or an explicit **path**.

## Decision tree — intent → command

| User says | What to run |
|---|---|
| "make a video about X" | `pnpm dhee new <name> --story story.txt --style live --duration 60` then `pnpm dhee run <name>` |
| "what's going on?" / "did anything fail?" | `pnpm dhee status <name>` (then `pnpm dhee inspect <name> <failed-node>`) |
| "show me [thing]" | `pnpm dhee inspect <name> <nodeId> [--item <itemId>]` |
| "stop before video" | `pnpm dhee run <name> --to shot_image` (gate at a stage) |
| "redo the world style" | `pnpm dhee regen <name> world_style` (re-runs it + everything downstream) |
| "regenerate shot 3 of scene 1's image" | `pnpm dhee regen <name> shot_image --item scene_1_shot_3` |
| "I'll write the plot myself" | `pnpm dhee override <name> story --from my_story.md` then `pnpm dhee run <name>` |
| "stop! I changed my mind" | `pnpm dhee stop <name>` (or Ctrl-C in the run terminal) |

## Node ids (the `narrative_prompt_relay` bundle)

The "stages" are bundle node ids. Pass any of them to `run --to`, or to
`inspect` / `regen` / `override`:

```
story → story_essence → world_style → characters_plan →
character_image_prompt → character_image → settings_plan →
setting_image_prompt → setting_image → scenes_plan →
shot_image_prompt → shot_image → shot_motion_directive →
scene_video_prompt → scene_clip → final_video
```

**Collection nodes** (one output per item) take `--item <itemId>`:
`character_image_prompt`, `character_image`, `setting_image_prompt`,
`setting_image`, `shot_image_prompt`, `shot_image`,
`shot_motion_directive`, `scene_video_prompt`, `scene_clip`. Item ids look
like `scene_1_shot_3` (shots) or a character/setting slug.

Other bundles have different nodes — run `pnpm dhee nodes <project>` (after
a first run) or `pnpm dhee bundles` to see what's available. Common stops:

- `pnpm dhee run myproj --to scenes_plan` — plan scenes/shots, no media yet
- `pnpm dhee run myproj --to shot_image` — render all shot frames, stop before video
- `pnpm dhee run myproj` — go all the way to `final_video`

## The edit → cascade contract

When you change a node's content, downstream consumers must re-run.

```
1. inspect   — pnpm dhee inspect myproj scenes_plan        # read current
2. override  — pnpm dhee override myproj scenes_plan --from new.json
               # writes content AND invalidates downstream entries
3. run       — pnpm dhee run myproj                         # re-executes invalidated nodes
```

- `override` of a **fan-out source** (e.g. `scenes_plan`, which feeds every
  shot) is high-blast-radius: the first call prints a blast-radius preview
  and does NOT write. Re-run with `--confirm` to apply. Surgical per-item
  writes (with `--item`) apply immediately.
- `regen <node>` is the one-step "let the LLM redo this": it invalidates
  the node **and** its downstream, then re-runs — no separate `run` needed.
  Use `--item` to scope a regen to a single collection item.

## Per-shot iteration (user wants tight control)

```bash
# Render just one shot's image, then stop:
pnpm dhee run myproj --to shot_image --only shot_image
pnpm dhee inspect myproj shot_image --item scene_1_shot_1     # look at it

# Don't like the framing? Edit the prompt and re-render just that image:
pnpm dhee inspect myproj shot_image_prompt --item scene_1_shot_1 > /tmp/p.json
# (edit /tmp/p.json — framing, lighting, etc.)
pnpm dhee override myproj shot_image_prompt --item scene_1_shot_1 --from /tmp/p.json
pnpm dhee regen   myproj shot_image --item scene_1_shot_1     # re-render that image only

# Happy? Render its video:
pnpm dhee regen myproj scene_clip --item scene_1            # or run --to scene_clip
```

## Stop / resume

`pnpm dhee stop <project>` writes a `.dhee.stop` sentinel into the project
dir. A running `pnpm dhee run` polls for it (~0.5s) and halts **before its
next node**; Ctrl-C in the run terminal does the same. State is persisted
on disk — a later `pnpm dhee run` resumes, skipping already-`completed`
nodes and re-running interrupted/failed ones. (A stale sentinel from a
prior stop is cleared automatically when the next `run` starts.)

## Style values

`--style` accepts the canonical ids `cinematic_realism` and `anime`, plus
aliases (case-insensitive): `live`/`live-action`/`realistic`/`cinematic` →
`cinematic_realism`; `animation`/`cartoon`/`2d` → `anime`.

## Tips

- **Start with `pnpm dhee status`** when joining a project — counts +
  failures in seconds.
- **`inspect` before `regen`.** Sometimes you'll just `override` the
  content instead of spending another LLM call.
- **Don't hand-edit `project.json`.** Use `override` — it writes the
  output file AND records the completion/invalidation atomically.
- **Logs:** `logs/llm-calls-truncated.log` for LLM-call failures,
  `logs/debug.log` for Comfy activity; per-project `<projectDir>/logs/`.
- **`new` defaults to `~/dhee-studios/<name>`.** Set `$dhee_PROJECTS_DIR`
  or pass `--dir <abs>` to put projects elsewhere.

## What this skill does NOT cover

- Editing bundle manifests / prompt templates under `src/dag/bundles/` or
  `prompts/` — that's source-code work, not pipeline driving.
- Changing the walker / runners (`src/dag/`, `src/server/runners/`). The
  CLI sits on top of those.
- The live desktop chat session. The CLI is the headless equivalent; it
  reuses the same runners and `dhee_*` tools.
```
