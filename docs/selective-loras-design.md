# Selective Per-Shot LoRAs — Design

**Status:** Design / proposal. Not launch-blocking.
**Author:** Ganaraj
**Date:** 2026-06-04

---

## TL;DR

Let users bring their own LoRAs and apply them **selectively** — a style LoRA
on the whole video, a trained character LoRA wherever that character appears, a
one-off FX LoRA on a single shot. The pipeline is already ~80% wired for this:
`comfy.image` injects workflow params via simple `{input, nodeId, field}`
mappings, and the LTX/qwen workflows already chain `LoraLoaderModelOnly` nodes.
The new work is (1) a declarative registry + scope-ranked assignment model the
user authors at creation time, (2) a pure per-shot resolver, and (3) LoRA slots
in the shot-image workflow + manifest mappings. Assignment is a workflow op the
agent can drive; the actual LoRA application stays in the runner/workflow.

---

## Motivation

`style` (`project.json.style`) is a constrained 5-option `select`
(`cinematic_realism | animation | noir | documentary | anime`) that is injected
as a one-word seed into the `world_style` LLM prompt
(`prompts/world_style.md:9` → `"User-selected style preset: {{style}}"`).
`world_style` is the **single visual-style hub** every downstream visual node
reads (characters, settings, all image prompts, motion, scene video prompt), so
it steers the *prompt*. But for a strong, specific look — e.g. **Amar Chitra
Katha** comic art — prompt steering alone often isn't enough: the shot-image
model (`klein.json`, a FLUX edit workflow) is photoreal-leaning and won't reach
a radical illustration style from text alone.

The model-level lever for that is a **LoRA**. Users also want their own trained
LoRAs (a character's face, a brand look, an FX) applied to *specific* shots, not
globally. There is no mechanism for that today.

---

## What already exists (the foundation)

| Capability | Where | Implication |
|---|---|---|
| Param injection into workflows | `comfy.image` runner — `parameterMappings: [{input, nodeId, field}]`, applied as `workflow[nodeId].inputs[field] = value` (`comfyImage.ts`) | Adding a LoRA param is a one-line manifest entry; no runner rewrite to *set* a field. |
| LoRA loaders in workflows | `LoraLoaderModelOnly` nodes (fields `lora_name`, `strength_model`) chained in `ltx_director_local.json`, `qwen_edit_multi.json` — including **named slots** (`LORA_MA`, `LORA_LIGHT`) | "Fixed named LoRA slots in a graph" is a proven pattern in this repo. |
| Shot-image model chain | `klein.json` has `UNETLoader` (node `92:70`) + `CLIPLoader` (`92:71`) | LoRA slots insert into this model chain; klein has **no** LoRA nodes yet. |
| Per-shot config injection point | Walker calls `applyAspectToConfig` per shot instance (~`walker.ts:1256`) and merges ambient `bundleInputs` into every node's `ctx.inputs` (`resolveBundleInputs`, ~`walker.ts:538`) | The exact hook to also inject a resolved LoRA stack into `cfg`. |
| Per-instance runner override | `dhee_swap_runner` accepts a per-`(nodeId,itemId)` `configOverride` | Drive-time "use LoRA X on shot 3" is already expressible. |

---

## Architecture — four layers

### 1. Registry — *what* LoRAs exist

A declarative `inputs/loras.json` (a new bundle input; ambient like `style`):

```json
{
  "registry": {
    "amar_chitra": { "file": "amar_chitra_v2.safetensors", "baseModel": "flux", "kind": "style",     "defaultStrength": 0.85 },
    "elara_face":  { "file": "elara_lora.safetensors",     "baseModel": "flux", "kind": "character", "defaultStrength": 0.9  },
    "explosion_fx":{ "file": "fx_boom.safetensors",        "baseModel": "flux", "kind": "concept",   "defaultStrength": 1.0  }
  }
}
```

- `baseModel` is **load-bearing**: a FLUX LoRA only works on a FLUX checkpoint.
  Resolution validates it against the workflow's declared model family; a
  mismatch is an error (or a logged skip), never a silent garbage render.
- **File availability:** LoRAs must live in the ComfyUI server's
  `models/loras/`. **v1: reference pre-installed files by name** and validate
  existence against Comfy's lora list (`/object_info`). **Later:** a
  `lora.sync` step (the runner already uploads reference images; LoRA upload is
  the same shape at larger size).

### 2. Assignment — the *selective* core

A scope-ranked assignment list, evaluated general → specific and **stacked**:

```json
{
  "assignments": [
    { "scope": "project",                          "lora": "amar_chitra",  "strength": 0.85 },
    { "scope": "scene",     "id": "scene_2",        "lora": "noir_grade",   "strength": 0.5  },
    { "scope": "character", "id": "elara",          "lora": "elara_face"    },
    { "scope": "shot",      "id": "scene_1_shot_3", "lora": "explosion_fx"  }
  ]
}
```

| Scope | Applies to | Mental model |
|---|---|---|
| `project` | every shot | model-level twin of `world_style` |
| `scene` | all shots in a scene | per-act look |
| `character` / `setting` | shots that reference that entity | the trained-face / branded-place LoRA |
| `shot` | explicit shot id(s) | one-off override / FX |

This expresses exactly: *"Amar Chitra everywhere, the hero always rendered with
her trained LoRA, scene 2 graded noir, and this one shot adds an explosion FX."*
The user authors this in `inputs/loras.json` **at project creation** — that is
the "great place to provide it." Drive-time tweaks go through the agent
(below).

### 3. Resolution — assignment → concrete per-shot stack

A pure, testable function:

```
resolveLorasForShot(
  { shotId, sceneId, characters, settings },   // shot context (walker has these)
  registry, assignments, { maxSlots, modelFamily }
) -> [{ file, strengthModel }]                  // ordered, deduped, capped
```

Rules: union all matching scopes → dedupe by file → order (`style` →
`character`/`setting` → `concept`/`shot`) → drop base-model mismatches (warn) →
cap at `maxSlots` (warn on overflow — **no silent truncation**).

Lives in `src/dag/loraResolve.ts`, called in the walker beside
`applyAspectToConfig`, setting `cfg.loras = [...]` for `shot_image` instances.
Mirrors the `applyAspect` pattern (pure transform on the runner config) and is
unit-testable without ComfyUI.

### 4. Injection — stack → workflow

Pre-wire **N `LoraLoaderModelOnly` slots** into `klein.json`, chained through the
model path:

```
UNETLoader(92:70) → LORA_1 → LORA_2 → LORA_3 → <sampler/guidance>
```

Declare per-slot mappings in `klein.manifest.json` (extends the existing
`parameterMappings`):

```json
{ "input": "lora_1_name",     "nodeId": "LORA_1", "field": "lora_name" },
{ "input": "lora_1_strength", "nodeId": "LORA_1", "field": "strength_model" },
{ "input": "lora_2_name",     "nodeId": "LORA_2", "field": "lora_name" },
...
```

The runner fills active slots from `cfg.loras` and **disables unused slots**
(`strength_model: 0`, or a sentinel "None"/passthrough LoRA). A small helper
expands `cfg.loras[]` → `{lora_1_name, lora_1_strength, ...}` so bundle authors
don't hand-map; everything else reuses the existing
`node.inputs[field] = value` apply loop.

> **Static-graph constraint.** ComfyUI graphs are fixed, so a *bounded* slot
> count is the pragmatic model. Unbounded stacks would require the runner to
> clone/wire LoRA nodes dynamically — deferred.

---

## Where it plugs into the codebase

| Piece | New / changed | Notes |
|---|---|---|
| `inputs/loras.json` schema | new | registry + assignments; a new bundle input, ambient via `resolveBundleInputs` |
| `src/dag/loraResolve.ts` | new | pure resolver + unit tests |
| `walker.ts` (~L1256) | ~5 lines | call resolver per `shot_image` instance, set `cfg.loras` next to `applyAspectToConfig` |
| `klein.json` | +N LoRA nodes | model-only slots in the UNET chain |
| `klein.manifest.json` | +2N mappings | slot params |
| `comfyImage.ts` | small | expand `cfg.loras[]` → slot params; zero unused slots |
| Agent: `dhee_assign_lora` (optional) | new tool | thin wrapper; `dhee_swap_runner` `configOverride` already covers the one-shot case |

---

## Agent boundary (workflow-manager principle)

LoRA **assignment** is a workflow operation — selecting which model applies
where. The agent can drive it (today via `dhee_swap_runner` `configOverride`;
better via a `dhee_assign_lora` tool). The **application** of the LoRA stays in
the runner/workflow, the domain layer — the agent orchestrates, runners do
domain work; it manages workflows, not model internals.

The agent **cannot verify** a LoRA "took" — it's blind to pixels (its image
tools return metadata/paths, not the rendered content). Confirming the style
landed needs a human or a `vlm.judge` node. This is another concrete argument
for that judge node.

---

## Hard parts / open questions

1. **Variable-length stacks vs static graph** — fixed N slots (recommend N=3) is
   the v1 cut; dynamic node-wiring is the escape hatch if needed.
2. **Base-model compatibility** — registry `baseModel` vs the workflow's model
   family; resolver must reject mismatches loudly.
3. **Character LoRA × reference-image conditioning** — `klein` already
   conditions on `reference_image_1..3` for character/setting consistency. A
   character LoRA may compound or fight with the ref images. Decide a rule:
   does a character LoRA **augment** or **replace** the ref-image path for that
   character? (Likely augment at lower strength; needs experiment.)
4. **File distribution** to the Comfy box — the real ops friction. v1:
   pre-installed-by-name. Then: an upload/sync step + a per-user LoRA library.
5. **Strength conflicts when stacking** — two style LoRAs at high strength wash
   each other out. Resolver should cap total strength or warn.
6. **Does it generalize to video?** The LTX `scene_clip` already has LoRA slots
   (nodes 80/81). The same registry/assignment model could feed them — out of
   scope for v1 but the design should not preclude it.

---

## v1 — smallest useful slice

- Scopes: **`project` + `shot`** only (defer scene/character).
- **3 model-only LoRA slots** in `klein.json` + manifest mappings.
- `inputs/loras.json` (registry + assignments); files **pre-installed by name**,
  validated against Comfy's lora list.
- `loraResolve.ts` + the walker hook + the runner expand-helper.
- Tests: `loraResolve` unit tests (scope union, dedup, cap, base-model reject);
  a runner test asserting `cfg.loras` injects into the right workflow fields.

Ships end-to-end: *"Amar Chitra style LoRA on every shot, FX LoRA on
`scene_1_shot_3`."* Scene/character scopes, file-sync, and video-clip LoRAs
follow.

---

## Testing

Per repo policy (`CLAUDE.md`): exercise behavior, not source strings.

- `loraResolve.test.ts` — call the resolver with synthetic registries +
  assignments; assert the resolved stack (order, dedup, cap, mismatch-drop).
- `comfyImage` injection — feed a stub workflow + `cfg.loras`; assert the
  resulting workflow JSON has the expected `LORA_n.lora_name` / `strength_model`
  set and unused slots zeroed.
- Walker integration — a bundle with a `shot_image` node + `inputs/loras.json`;
  assert the dispatched config carries the resolved stack (stub the comfy
  client, like `walkerChunkByUpstream` stubs the runner).
