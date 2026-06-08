---
name: bundle-authoring
version: 1.0.0
description: |
  Author a new dhee-core bundle (a pipeline) from scratch, or extend an
  existing one. Use when the user wants to "create a bundle", "add a
  pipeline", "make a new workflow flow", "add a stage/node to a bundle",
  "wire up a new ComfyUI workflow as a pipeline step", or "turn this
  sequence of steps into a bundle." Walks through the directory layout,
  bundle.json fields, node kinds / inputs / scopes, picking + pairing a
  runner with its workflow + manifest, declaring runner dependencies,
  validating, and test-running against real Comfy.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Authoring a dhee-core bundle

A **bundle** is a dependency graph (DAG) of typed nodes. Each node declares
its inputs and which **runner** produces its output. The **walker**
(`src/dag/walker.ts`) backward-walks from a `goal` node and runs nodes in
dependency order — it owns retries, caching, cascade invalidation, and
persistence. You author *data* (JSON + prompts + workflows); you do not
write walker code.

The authoritative schema is **`src/dag/schema.ts`** (`DagBundle`,
`NodeDef`, `NodeInput`, …). The conceptual companion is
**`docs/bundles-for-beginners.md`**. The best templates are the live
bundles under **`src/dag/bundles/`** — copy the closest one and adapt.

> **Golden rule:** the walker and runners stay generic; per-bundle and
> per-workflow knowledge lives in *data* (bundle.json + the workflow
> manifest). If you find yourself wanting to change runner code to make a
> bundle work, stop — it almost always belongs in the manifest or node
> config instead.

---

## 1. Pick a starting template

Don't start from a blank file. Match the shape you want:

| Want | Copy |
|------|------|
| Text-only (story → plans, no media) | `src/dag/bundles/narrative_text_only` |
| Single-file minimal bundle | `src/dag/bundles/ltx_prompt_relay.json` |
| Images + relay video | `src/dag/bundles/narrative_prompt_relay/` |
| Per-shot image→video | `src/dag/bundles/narrative_shot_by_shot/` |
| Iterative edit-chain shots | `src/dag/bundles/narrative_qwen_chain_relay/` |
| Any of the above + a VLM review loop | the `*_review` variants |

```bash
cp -r src/dag/bundles/narrative_prompt_relay src/dag/bundles/<your_bundle_id>
```

A bundle directory holds:

```
<bundle_id>/
  bundle.json            # the DAG (required)
  prompts/*.md           # llm.generate prompt templates ({{var}} substitution)
  schemas/*.schema.json  # JSON-Schema for json-output LLM nodes
  workflows/*.json       # ComfyUI API-format workflow graphs
  workflows/*.manifest.json  # input→node mappings for each comfy workflow
```

A bundle may also be a **single `.json` file** (no sibling assets) when it
has no prompts/workflows of its own.

---

## 2. `bundle.json` top-level fields

(See `DagBundle` in `src/dag/schema.ts`.)

```jsonc
{
  "id": "your_bundle_id",          // unique; match the directory name
  "version": "0.1.0",
  "displayName": "Your Bundle",    // optional; picker card title
  "summary": "One-line tagline.",  // optional; ≤120 chars
  "techLine": "FLUX 2 KLEIN · LTX RELAY", // optional uppercase caption
  "description": "Long-form prose.",
  "engineCompat": ">=0.1.0",
  "dependencies": { "runners": { /* see §6 */ } },
  "inputs": [ /* bundle-level inputs, see §7 */ ],
  "goal": "final_video",           // the terminal node the walker produces
  "nodes": [ /* see §3–§5 */ ]
}
```

---

## 3. Nodes: kinds, inputs, outputs

(See `NodeDef`, `NodeInput`, `NodeOutput`.)

```jsonc
{
  "id": "shot_image",
  "kind": "collection",            // "stage" (one) | "collection" (fan-out)
  "itemSource": "shot_image_prompt", // collection: upstream id to fan out over
  "itemKey": "shots",              // when the source JSON has >1 array, name it
  "inputs": [
    { "from": "shot_image_prompt", "usage": "input",     "scope": "matching" },
    { "from": "character_image",   "usage": "reference",  "scope": "all" },
    { "from": "setting_image",     "usage": "reference",  "scope": "all" }
  ],
  "outputs": {
    "format": "image",             // md | json | image | video | audio | text
    "pattern": "assets/images/shots/{{item_id}}_first.png"  // {{item_id}}/{{scene_id}}/{{shot_id}}
  },
  "runner": { "tool": "comfy.klein", "config": { /* see §5 */ } },
  "headlineField": "imagePrompt",  // json nodes: dot-path the desktop shows
  "displayCapability": "shot.first_frame" // bundle↔desktop contract (see docs/display-capabilities.md)
}
```

**`kind`** — `stage` = one instance; `collection` = fans out over each item
of `itemSource` (e.g. one shot_image per shot).

**`inputs[].usage`** — `input` (primary; drives the prompt/content),
`context` (background reference for an LLM), `reference` (an upstream
artifact like an image), `aggregate` (pack N upstream items into one call;
set `aggregate: { strategy: 'list'|'join', sep?, limit? }`).

**`inputs[].scope`** (collection sources only):
- `matching` — the upstream item with the same `item_id` (1:1 fan-out).
- `all` — every item, exposed to the runner as `{ itemId → absolutePath }`.
- `any` — first available.
- `previousN` — the N prior instances by shotNumber (set `n`); for
  edit-chain bundles that condition on earlier shots.

**`outputs.pattern`** — where the artifact lands under the project dir.
Use `{{item_id}}` for collections.

---

## 4. Walk the graph backward from `goal`

Author nodes by starting at `goal` and asking "what does this need?" until
you bottom out at the bundle inputs. Every arrow in the diagram is one
`{ "from": "...", "usage": "..." }` entry. The narrative bundles' shape:

```
story → story_essence / world_style / characters_plan / settings_plan / scenes_plan
characters_plan → character_image_prompt → character_image
settings_plan   → setting_image_prompt   → setting_image
scenes_plan     → shot_image_prompt → shot_image (+ character_image[all], setting_image[all])
                → shot_motion_directive / scene_video_prompt → scene_clip → final_video
```

LLM nodes (`llm.generate`) read upstream outputs as `context`/`input`;
media nodes (`comfy.*`) consume the resolved prompt + reference images.

---

## 5. Pick + pair a runner

Runners are registered tools (see `src/dag/runners/index.ts`). Each
ComfyUI runner is **NAMED for the workflow family it drives** and is
allowed to know that workflow's shape — there is **no generic `comfy`
runner**. Pick the one whose shape matches your workflow:

| Tool | Use for | Needs |
|------|---------|-------|
| `llm.generate` | text/JSON generation | `promptTemplate`, `tier`, `outputFormat`, optional `outputSchema` |
| `comfy.tti` | text-to-image (no refs) | `workflowPath` + `manifestPath`, `width`/`height` |
| `comfy.klein` | Flux 2 Klein reference-edit (base + up to 3 refs) | `workflowPath` + `manifestPath` (klein-shaped graph) |
| `comfy.fl2v` | first/last-frame → video | `workflowPath` + `manifestPath` |
| `comfy.ltx_director` | multi-shot relay video | `workflowPath`, `shots`, `firstFrames`, `globalPrompt`, `fps` |
| `comfy.qwen_edit_chain` | iterative edit-chain shots | `workflowPath`, chain config |
| `ffmpeg.concat` | stitch clips → final video | `{}` (wires from upstream) |
| `vlm.judge` | pass/fail review of an image | VLM endpoint config |

All `comfy.*` runners share one **workflow-agnostic core**
(`src/dag/runners/comfyExecutor.ts`) for endpoint resolution, image
upload, queue/download, model aliases, and caching. The core is **NOT a
runner** — only the tools above are registered.

### Comfy runner config + the manifest pairing

A comfy node's config names a workflow JSON and its manifest:

```jsonc
"runner": {
  "tool": "comfy.klein",
  "config": {
    "workflowPath": "workflows/klein.json",
    "manifestPath": "workflows/klein.manifest.json",
    "endpoint": "public.cloud",   // resolved via ENDPOINT_<name> env (Settings)
    "width": 1920, "height": 1080
  }
}
```

The **manifest** is how the runner injects values into the raw ComfyUI
graph without code:

```jsonc
{
  "inputRequirements": [
    { "id": "prompt",            "type": "text",  "source": "llm",        "required": true  },
    { "id": "base_image",        "type": "image", "source": "shot_image", "required": true  },
    { "id": "reference_image_1", "type": "image", "source": "shot_image", "required": false }
  ],
  "parameterMappings": [
    { "input": "prompt",            "nodeId": "109", "field": "text"  },
    { "input": "base_image",        "nodeId": "76",  "field": "image" },
    { "input": "reference_image_1", "nodeId": "81",  "field": "image" }
  ]
}
```

- `parameterMappings` set `workflow[nodeId].inputs[field] = value`. Adding a
  knob (a LoRA strength, a new ref slot) is a one-line manifest entry — no
  runner change.
- `inputRequirements[].required: true` makes the executor **fail fast** with
  an actionable message when that input can't be resolved (no per-workflow
  heuristic). Mark only the genuinely mandatory ones required.
- For `comfy.klein`, optional `reference_image_*` that resolve to nothing are
  **pruned from the graph** (their LoadImage branch is deleted and the
  ReferenceLatent chain rewired) so Comfy never validates a placeholder
  filename. That prune topology is klein-specific and lives in
  `src/dag/runners/comfyKlein.ts` — a *different* reference-edit workflow
  with a different graph needs its OWN bound runner, not a reuse of
  `comfy.klein`.

---

## 6. Declare `dependencies.runners`

List **every** tool any node uses, with a semver range. The walker
validates these against the `RunnerRegistry` **before** running — an
unregistered tool (or a version mismatch) fails the bundle up front.

```jsonc
"dependencies": {
  "runners": {
    "llm.generate":  ">=0.1.0",
    "comfy.tti":     ">=0.1.0",
    "comfy.klein":   ">=0.1.0",
    "ffmpeg.concat": ">=0.1.0"
  }
}
```

Keep this in lockstep with the tools your nodes reference — a node using
`comfy.klein` while deps only list `comfy.image` (the old, removed name)
will fail the requirements check.

---

## 7. Bundle-level inputs (optional)

Values fed to every node's `ctx.inputs` from outside the DAG — the user's
story text, project metadata, style. (See `BundleInputDecl`.)

```jsonc
"inputs": [
  { "id": "story_input", "kind": "file",    "path": "inputs/story.md", "required": true,
    "label": "Story", "multiline": true },
  { "id": "style",       "kind": "project", "field": "style", "control": "select",
    "options": [ { "value": "cinematic_realism", "label": "Cinematic" } ],
    "allowCustom": true }
]
```

`kind: file` reads a project file; `kind: project` reads a `project.json`
field. The presentation fields (`label`, `control`, `options`, …) drive the
desktop's New Project form and have no runtime effect.

---

## 8. Validate & test-run

```bash
# 1. Does it load + resolve? (lists all bundles; yours should appear)
pnpm dhee bundles

# 2. Static check — missing runners, unresolved workflow models, etc.
#    (src/dag/checkBundle.ts aggregates the requirements + workflow checks;
#     the agent tool dhee_check_workflow probes a Comfy endpoint for missing models.)

# 3. Dry-run ONE stage against real Comfy without the expensive tail.
#    run-to runs the graph up to (and including) <nodeId> and stops.
pnpm dhee new "<name>" --story <file> --bundle <your_bundle_id> --dir /tmp/test-proj
pnpm dhee run-to /tmp/test-proj <some_early_node>     # e.g. character_image

# If .env points self.local at a dead tunnel, override the endpoint:
COMFY_MODE=local ENDPOINT_self_local=http://<host>:8188 COMFYUI_BASE_URL=http://<host>:8188 \
  pnpm dhee run-to /tmp/test-proj shot_image
```

Confirm the produced artifacts land at each node's `outputs.pattern` and
are real (non-empty, correct format). Then widen to `run` (to the goal).

---

## 9. Gotchas (learned the hard way)

- **Runner deps must match node tools exactly** — a stale `comfy.image`
  in `dependencies.runners` fails the pre-walk check (the tool was split
  into `comfy.klein` / `comfy.tti` / `comfy.fl2v`).
- **A comfy runner is bound to its workflow's shape.** Don't point
  `comfy.klein` at a non-klein graph; author/choose the runner that matches.
- **Every `LoadImage` Comfy validates must resolve to a real uploaded
  file.** Leftover placeholder filenames (`ref_image_1.png`) fail with
  `prompt_outputs_failed_validation`. For klein this is handled by
  prune-on-absent; for a new workflow, either make the input `required` or
  give its runner a prune rule.
- **`itemKey` matters** when an upstream JSON has more than one array — set
  it (e.g. `"shots"`) or the walker guesses the first array.
- **`displayCapability`** is how the desktop knows what to render — use the
  reserved tags (`shot.first_frame`, `character.image`, …) when your node
  produces a known artifact type, or a custom `<domain>.<artifact>` tag.

## Reference files
- Schema: `src/dag/schema.ts`
- Concepts: `docs/bundles-for-beginners.md`
- Desktop contract: `docs/display-capabilities.md`
- Example bundles: `src/dag/bundles/*`
- Comfy runners: `src/dag/runners/comfy{Executor,Klein,Tti,Fl2v}.ts`
