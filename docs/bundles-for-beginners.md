# Bundles: What They Are, What They Can Do (Beginner's Guide)

If you've never touched this codebase before, start here. This doc
explains the new **Bundle** architecture in plain English — what a
bundle is, why it exists, what it lets you do that was impossible
before, and how far you can push it.

No prior knowledge of the old executor required.

---

## 1. The one-sentence pitch

> A **bundle** is a recipe-as-a-file that tells the engine how to turn
> a story (or any input) into a finished video — by declaring **what
> depends on what**, not by writing code.

Everything else in this document is unpacking that sentence.

---

## 2. The mental model: dependencies, not pipelines

Old way (mental model): "first do A, then B, then C, then D."

New way (mental model): "D needs C. C needs B. B needs A. Figure it
out."

You don't write the order. You declare each piece's dependencies. The
engine walks **backward** from your goal (usually `final_video`) and
runs whatever is needed, in whatever order is valid, in parallel
wherever possible.

Why it matters: adding a new capability (audio, subtitles, pose
control, a new model) is no longer "rewrite the pipeline." It is
"add one node, draw one new dependency line."

---

## 3. The pieces of a bundle

A bundle is a folder. The most important file is `bundle.json`.

```
my_bundle/
├── bundle.json          ← the recipe (the DAG)
├── prompts/             ← LLM prompt templates
├── schemas/             ← JSON schemas for validated LLM outputs
└── workflows/           ← ComfyUI workflow JSON + manifest pairs
```

Inside `bundle.json`, the four things you care about:

1. **`goal`** — what you're trying to produce (e.g. `"final_video"`).
2. **`inputs`** — what the bundle reads from outside the DAG (the
   user's story, project settings).
3. **`nodes`** — the actual graph. Each node has:
   - `id` — a name like `plot`, `scene_clip`, `character_image`.
   - `kind` — `stage` (one of these exists) or `collection` (fans
     out, one per item).
   - `inputs` — list of upstream nodes this one depends on, and
     **how** it uses them (`context`, `reference`, `input`,
     `aggregate`).
   - `outputs` — the file format + where it lands on disk.
   - `runner` — which tool runs this node, and the tool's config.
4. **`dependencies.runners`** — which runner tools the bundle needs
   (`llm.generate`, `comfy.klein`, etc.) and at what versions.

That's it. No code. Just JSON.

---

## 4. The four primitives you'll use over and over

### Node kinds

- **`stage`** — exactly one of these runs. Examples: `plot`, `story`,
  `world_style`, `final_video`.
- **`collection`** — fans out into N instances. Example:
  `shot_image` runs once per shot. You point it at an `itemSource`
  (the upstream node whose output drives the fan-out) and the
  walker materializes the instances **at runtime**, after the source
  completes.

### Input "usage"

When node B depends on node A, you also say *how* B uses A:

- **`context`** — A's output is background reading for B (e.g. the
  scene description goes into an LLM prompt as context).
- **`reference`** — A's output is a visual reference (e.g. a
  character image used as a reference image in Klein).
- **`input`** — A's output IS the input (e.g. a first-frame PNG fed
  to a video model).
- **`aggregate`** — many upstream items collapse into one downstream
  call (e.g. all shot images of a scene → one relay clip; all clips
  → one ffmpeg concat).

### Input "scope"

For collection upstreams:

- **`all`** — pull all items (e.g. all character images).
- **`matching`** — pull only the items that "match" this instance
  (e.g. only this shot's image, not every shot's).
- **`previousN`** — pull the N prior instances by shot number
  (Qwen-chain bundles use this to feed prior frames as edit base).

### Runners

The built-in runners cover most cases. Each ComfyUI runner is NAMED for
the workflow family it drives (it's allowed to know that workflow's
shape) — there is no single generic "comfy" runner:

| Runner | What it does |
|--------|--------------|
| `llm.generate` | Renders a prompt template, calls the LLM, writes the output file (markdown or schema-validated JSON). |
| `comfy.tti` | Runs a ComfyUI text-to-image workflow (prompt → image, no references). Used for character / setting reference renders. |
| `comfy.klein` | Runs the Flux 2 Klein reference-edit workflow: a base image + up to 3 optional references; absent references are pruned from the graph. |
| `comfy.fl2v` | Runs a first-frame/last-frame → video ComfyUI workflow. |
| `comfy.ltx_director` | Drives the LTX Director Chain workflow to produce a continuous multi-segment video clip. |
| `comfy.qwen_edit_chain` | Iteratively edits a prior shot into the next via Qwen-Image-Edit (camera-rotation continuity). |
| `ffmpeg.concat` | Stitches a list of clips into one final video. |

All the `comfy.*` runners share one workflow-agnostic core
(`comfyExecutor`) for endpoint resolution, image upload, queueing,
download, model aliases, and caching — but the core is **not itself a
runner**; only the named tools above are registered and targetable by a
bundle node.

Anyone can write a new runner (an API wrapper, a new local workflow,
a custom postprocess step) and drop it into `~/.kshana/runners/`.
The engine picks it up at startup.

---

## 5. Worked example #1 — the simplest possible bundle

A two-node bundle: take user text, generate one image.

```jsonc
{
  "id": "story_to_image",
  "version": "0.1.0",
  "goal": "cover_image",
  "inputs": [
    { "id": "story_input", "kind": "file", "path": "inputs/story.md" }
  ],
  "nodes": [
    {
      "id": "cover_prompt",
      "kind": "stage",
      "inputs": [],
      "outputs": { "format": "md", "pattern": "plans/cover_prompt.md" },
      "runner": {
        "tool": "llm.generate",
        "config": {
          "promptTemplate": "prompts/cover_prompt.md",
          "tier": "medium"
        }
      }
    },
    {
      "id": "cover_image",
      "kind": "stage",
      "inputs": [
        { "from": "cover_prompt", "usage": "input" }
      ],
      "outputs": { "format": "image", "pattern": "assets/cover.png" },
      "runner": {
        "tool": "comfy.klein",
        "config": {
          "workflowPath": "workflows/klein.json",
          "manifestPath": "workflows/klein.manifest.json",
          "endpoint": "self.local",
          "width": 1024, "height": 1024
        }
      }
    }
  ]
}
```

Walker reads `goal: cover_image` → sees it needs `cover_prompt` →
sees `cover_prompt` has no deps → runs LLM → writes
`plans/cover_prompt.md` → unblocks `cover_image` → runs Klein → done.

---

## 6. Worked example #2 — the real shot-by-shot pipeline

This is the production bundle (`narrative_shot_by_shot`). The actual
JSON has ~18 nodes; here's the dependency shape:

```
            ┌───────┐
user idea → │ plot  │
            └───┬───┘
                ↓
            ┌───────┐
            │ story │
            └───┬───┘
   ┌────────────┼────────────┬─────────────┐
   ↓            ↓            ↓             ↓
story_essence  world_style  characters_plan  settings_plan  scenes_plan
                                │                │              │
                                ↓                ↓              ↓
                       character_image    setting_image    shot_image_prompt (fan-out per shot)
                                                                 │
                                              ┌──────────────────┼──────────────────┐
                                              ↓                  ↓                  ↓
                                         shot_image    shot_image_last_frame   shot_motion_directive
                                              └──────┬───────────┴──────────────────┘
                                                     ↓
                                                shot_video  (per shot)
                                                     ↓
                                                final_video  (ffmpeg.concat all shots)
```

Every arrow is a single line in `bundle.json` (`{ "from": "plot",
"usage": "context" }`). That's the entire pipeline.

If your computer dies after `shot_image` for shots 1–3 are done, you
resume the project, the walker sees those three files on disk, skips
them, and continues from shot 4. No bookkeeping you have to write.

---

## 7. What was hard before bundles, and is now easy

This is the part where the architecture's value shows up.

### a) Swap one image model for another → one-line edit

```jsonc
"runner": {
  "tool": "comfy.klein",
  "config": { "workflowPath": "workflows/klein.json", ... }
}
```

Change `klein.json` to `qwen_edit.json` (and its matching
`.manifest.json`). Done. No code touched. Save as a new bundle if
you want to keep both around.

### b) Add audio to the pipeline → one new node + one new edge

```jsonc
// 1. New node
{
  "id": "shot_audio",
  "kind": "collection",
  "itemSource": "shot",
  "inputs": [{ "from": "shot", "usage": "context" }],
  "outputs": { "format": "audio", "pattern": "audio/{{item_id}}.mp3" },
  "runner": { "tool": "tts.elevenlabs", "config": { ... } }
}

// 2. shot_video adds one input
{
  "id": "shot_video",
  "inputs": [
    ...existing inputs,
    { "from": "shot_audio", "usage": "input", "scope": "matching" }
  ]
}
```

No flow named "narrative-with-audio." No flag. Just an edge.

### c) Use a totally different video backend (Seedance, Veo, Kling, Runway)

Write a runner once (~150 lines of TypeScript: take config, call the
API, save the file). Drop it in `~/.kshana/runners/`. Now every
bundle author can use it. The bundle that uses it differs from the
LTX one in **one node's `runner` block**.

### d) Make the pipeline work on someone else's machine

A bundle is self-contained — `bundle.json` + its prompts +
workflows + schemas all live in one folder. Zip it, share it.
Whoever has the runners the bundle declares can run it.

### e) Branch the pipeline by user goal

Old pipeline knew about exactly one final output. The new walker
runs from whatever node id you tell it is the goal. Want to stop
after images and not generate videos? Set `stopAt: "shot_image"`.
Want a totally different final assembly? Author one — old final
becomes an unreachable node, walker prunes it.

### f) Mix local + cloud in one run

Each Comfy node declares an `endpoint`. The Klein steps can run on
cloud while LTX runs locally (or vice versa) — same bundle, two
endpoints. The walker doesn't care; it just dispatches.

---

## 8. Wild examples of what you can build

These are not in the repo today. They are within reach because the
graph model doesn't care about the content — only about
dependencies.

### Multi-style A/B render of the same story

One bundle. Three `final_video_*` goal nodes:

```
final_video_anime  ← shot_video_anime   ← shot_image (Klein with anime LoRA)
final_video_noir   ← shot_video_noir    ← shot_image (Klein with noir LoRA)
final_video_3d     ← shot_video_3d      ← shot_image (Klein with 3D LoRA)
```

`shot_image_prompt` is shared. The graph fans out three ways from
the same upstream content. One walk = three finished videos in
different styles. Quality-compare side-by-side.

### Director cut + extended cut from the same source

Two `final_video_*` goals, one with all shots, one with a curated
subset declared by a `shot_selection` LLM node that picks "best
shots only." Walker runs both. You get two cuts without re-rendering
anything.

### Auto-graded portfolio

A bundle whose final stage isn't a video — it's a `grade_report`
node powered by `llm.generate` that reads every shot image and
writes a markdown critique of the project. Drop in a `grader.md`
prompt. Now you have a quality assistant that scores your own
output.

### "Side B" reverse-angle entire scene

Add a `shot_image_side_b` collection that takes each `shot_image`
and produces the 180° reverse angle via Qwen Edit + multi-angle
LoRA. Author a `shot_video_side_b` that goes from side B as its
first frame. Now `final_video` has both angles intercut. None of
the existing nodes change — you only add new nodes.

### Live-comic-book mode

Swap `shot_video` for an `ffmpeg.kenburns` runner (slow pan/zoom
across the still image with motion blur). Add `shot_caption` (LLM
generates a comic-book caption text per shot) and an `ffmpeg.overlay`
runner that burns the caption onto the panel. Final video is a
narrated motion-comic. The narrative structure is the same; only
the leaf renderers change.

### Voice-cloned narrator on top of musical underscore

- `narration_text` (LLM): generates voiceover script per scene.
- `narration_audio` (TTS runner, voice-cloned to user's sample).
- `music_bed` (audio-gen runner, mood-matched to scene_essence).
- `audio_mix` (ffmpeg mix).
- `final_video` adds an `audio_mix` input. Done.

### Multilingual auto-localization

Add a `subtitle_<lang>` collection that fans out one per requested
language, each running an LLM translation node on the source
dialogue. Add an `ffmpeg.subtitle_burn` runner. Now one bundle run
produces final videos in N languages from the same shots.

### "Re-render only what changed" iteration loop

Edit a prompt for shot 7. Run `redo("shot_image", "scene_2_shot_7")`.
Walker invalidates that one image + everything downstream of it
(shot_video for that shot + final_video), and *only those nodes*
re-execute. The other 23 shots stay untouched. Old executors
either re-ran everything or required carefully crafted "rerun this
step only" hacks. The walker gives this to you for free because
dependencies are explicit.

### Use a totally different LLM for one node

Every `llm.generate` node has a `tier` (HEAVY / MEDIUM / LIGHT)
that routes through a configurable LLM router. Want to use Claude
for the story but DeepSeek for shot prompts? Set the tier mapping
in your env. Want to use a *different model entirely* for one node?
Write a `llm.openrouter_custom` runner that takes `model:
"anthropic/claude-opus-4-7"`, point that one node at it. Other
nodes are unaffected.

### Crowd-sourced bundle library

Because bundles are JSON folders, they're shareable artifacts. A
community could publish bundles for "music video," "explainer," "ad
spot," "podcast visualizer," "tarot reading," etc. — each a complete
graph. Users pick one, change the inputs, run.

### Pipeline that adapts to hardware

A bundle could declare alternative `runner` blocks gated on
`endpoint` capability — but more simply: ship two bundles
(`narrative_relay_3060.json` with a 4-segment cap, and
`narrative_relay_4090.json` with 8 segments). The schema already
supports `chunkBy` to subdivide oversized scenes automatically into
chunks that fit the runner's frame budget. Big scene + small GPU =
multiple chunks, stitched.

### Re-render any single layer without losing everything else

Change of mind on art style halfway through? Invalidate
`world_style`. The walker cascades the invalidation through
everything that depended on it (character images, setting images,
shot images, shot videos, final video) — all marked stale, all
re-rendered. The plot, story, scenes plan, and dialogue stay
untouched. Old executors couldn't reason about "what depends on
world_style"; the bundle's graph makes the answer trivial.

---

## 9. The hard part isn't the bundle — it's the runner

Bundles are JSON. They are easy to author once you understand the
shape. The interesting work going forward is **runners**:

- A `tts.elevenlabs` runner unlocks every audio-flavored bundle.
- A `seedance.t2v` runner unlocks every Seedance-flavored bundle.
- A `ffmpeg.kenburns` runner unlocks the comic-book mode.
- A `wan.i2v` or `kling.i2v` runner unlocks those generators.

Each runner is ~100–300 lines of TypeScript: read config, do the
thing, write the output file, return `{ ok: true, outputPath }`.
The runner ships with a manifest (its tool name, version, what
credentials it needs) and gets auto-registered.

The architectural promise: **runners are the new plugin surface**.
Once someone in the community writes one, every bundle author has
it forever.

---

## 10. How to actually run a bundle

Today, from the CLI:

```
pnpm tsx scripts/run-project-via-bundle.ts \
  --project ./my_story.kshana \
  --bundle built-in:narrative_shot_by_shot
```

Three bundle source URI formats:

- `built-in:<name>` — ships with the engine
  (`src/dag/bundles/<name>/`).
- `user:<path>` — a folder anywhere on disk.
- `registry:<id>@<version>` — future: shared bundle registry.

The walker reads `bundle.json`, validates that all declared runners
are registered with compatible versions, and starts walking. Logs
land in `logs/` (the CLAUDE.md rule "always check logs when
debugging" applies here too).

---

## 11. What's still missing (as of this writing)

The architecture is real but not done.

- **Walker fan-out across two-level collections** is partial. Some
  expansion cases still need work before all flows hit parity with
  the legacy executor.
- **`comfy.ltx_fl2v`** runner (per-shot FL2V) isn't shipped yet —
  needed for full `narrative_shot_by_shot` on cloud Comfy.
- **Agent verbs (`redo`, `override_param`, `override_content`)** are
  designed but not all surfaced through the chat UI yet.
- **Runner self-description** (`describe()` returning a config JSON
  Schema) is in the schema but only loosely enforced.
- **Cross-runner equivalent-swap** ("swap LTX for Seedance with one
  click") is intentionally out of scope — too speculative until
  someone proves they want it badly enough to pay the complexity.

These are tracked in `docs/two-bundles-build-status.md` and
`docs/bundle-migration-plan.md`.

---

## 12. The bigger picture

The old executor was a giant switch statement on artifact type — 990
lines that grew every time someone added a feature. Each new
capability touched core code. Each user-specific tweak was a fork.

Bundles invert that. The core is small (a graph walker + four
runners). Capabilities live in **data** (bundles) and **plugins**
(runners). Adding "audio" doesn't change the engine; it changes a
JSON file and ships a runner.

The first big win is what you saw above: features that were
multi-day code changes become one-line edits in JSON. The second,
bigger win is shareability — once bundles are tradeable artifacts
and runners are pluggable, the engine stops being the bottleneck
and the community becomes the feature factory.

That's the bet. The two-bundle build now in progress is what proves
it on real video, not just on paper.
