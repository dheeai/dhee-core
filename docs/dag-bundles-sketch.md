# DAG Bundles — Tier 1 Paper Test

**Status:** design complete (2026-05-26). Next concrete steps TBD —
not started.

Three concrete flow definitions to pressure-test the bundle schema **before**
writing any executor code. The goal here is not to be runnable; it is to
expose places where the schema strains.

## Decisions locked in this design pass

1. **Bundle layer above ComfyUI manifests, not parallel to them.** Bundle
   nodes bind to existing workflow `*.manifest.json` files via
   `inputRequirements` + `parameterMappings`. Half the schema work is
   already done by the manifests we have.

2. **Dependency declaration, not forward pipeline.** Every node declares
   its `inputs[]`; execution order emerges from a backward walk from the
   goal node. `BackwardPlanner.findRequiredArtifacts` already implements
   this for current templates.

3. **No "flows" — just graphs.** A flow is a choice of dependency edges,
   not a separate bundle type. Audio is a node + an edge; pose is a node
   + an edge.

4. **Complete graphs only, never fragments.** Each shared graph is
   idempotent and self-contained. Composition is an authoring-time editor
   concern; the saved/shared artifact is always a complete graph.
   Provenance (`derivedFrom`) is metadata, not execution semantics.

5. **Four runners cover the three example flows:** `llm.generate`,
   `comfy.run`, `seedance.t2v`, `ffmpeg.concat`. Custom Loras and
   fine-tunes are entirely a manifest swap — no bundle change.

6. **Variable-N indexed cardinality on workflow slots.** The "4-shot LTX
   relay" is one workflow file; the schema supports `cardinality: { kind:
   'indexed', min, max }` on manifest slots, with bundles binding
   collections via templated indexing.

7. **`aggregate` is the fourth input usage** (alongside `context`,
   `reference`, `input`). Needed for pack-N-into-one calls (relay,
   audio, ffmpeg concat).

8. **Runner self-description is load-bearing.** Runners declare their
   capabilities + JSON Schema for inputs; agent uses this for validate,
   edit, and (no longer) swap. Without self-description, community
   runners can't be safely shared.

9. **Agent tool surface is three verbs:** `redo`, `override_param`,
   `override_content`. `swap_runner` was considered and dropped —
   cross-runner equivalence needs too much speculative machinery for
   the value it delivers.

10. **The walker is iterative reconciliation, not topo-sort.** Backward
    walk → materialize per-item instances → compute ready → dispatch →
    on completion, repeat. The existing `DependencyGraphExecutor`'s 990
    lines are mostly this loop with all its corner cases preserved.

## Open questions deferred to implementation

- Editor UX for graph authoring + composition
- Hardware portability for shared graphs (when a 4090-authored 8-segment
  graph meets a 3060)
- Sprawl management in the share registry as variants multiply
- Concrete migration plan from existing template-based executor to
  bundle-based executor (incremental, not big-bang)

Important grounding: `workflows/built-in/*.manifest.json` already define
the workflow interface (`inputRequirements`, `parameterMappings`). The
bundle layer below sits **above** those manifests — it binds bundle node
inputs to workflow input slots, and lets workflows be swapped without
touching the bundle's node shape.

## Mental model: dependency declaration, not pipeline

**There is no forward pipeline.** Every node declares what *it* needs (its
`inputs[]`); the actual execution order emerges from a backward walk
starting at `final_video` (or whatever the user's goal node is). The
existing `src/core/planner/BackwardPlanner.ts` already implements this for
the current artifact templates — `findRequiredArtifacts(targets)` does a
backward BFS through dependency edges. The bundle schema is just the data
shape feeding that same walker.

This reframes "flows" significantly: **a flow is not a separate bundle —
it is a choice of which dependency edges you draw.** Adding audio is not
"flow A vs flow A-with-audio"; it is "add a `shot_audio` node and have
`shot_video` depend on it." Same with pose, same with any new capability.

Read the three bundles below as **example dependency graphs**, not as
locked-down templates. The interesting variation between them lives in
the edges, not in any flow-level abstraction.

## Schema preview

```ts
interface DagBundle {
  id: string;
  version: string;
  author?: string;
  nodes: NodeDef[];
  // Runner implementations referenced by nodes[].runner.tool.
  // Built-ins live in src/runners/. Bundles can ship custom runners too.
  runnerHints?: Record<string, { description: string }>;
}

interface NodeDef {
  id: string;                          // 'scene', 'shot_image', 'scene_clip', …
  kind: 'stage' | 'collection';
  itemSource?: string;                 // collection only: upstream node whose items
                                       //   we fan out over (e.g. 'scene' for 'shot')

  inputs: Array<{
    from: string;                      // upstream node id
    usage: 'context' | 'reference' | 'input' | 'aggregate';
    scope?: 'all' | 'matching' | 'any';
    // For 'aggregate': how upstream items are packed into this node's call.
    aggregate?: { strategy: 'list' | 'join'; sep?: string; limit?: number };
  }>;

  outputs: {
    format: 'md' | 'json' | 'image' | 'video' | 'audio';
    pattern: string;                   // file pattern, supports {{id}}/{{index}}
  };

  runner: {
    tool: string;                      // 'llm.generate', 'comfy.run', 'seedance.t2v', 'ffmpeg.concat'
    config: Record<string, unknown>;
  };
}
```

The runners we need for these three flows:

- `llm.generate` — text generation from a prompt template + context inputs
- `comfy.run` — runs a Comfy workflow JSON via its manifest, binds inputs to node fields
- `seedance.t2v` — Seedance text-to-video API call
- `ffmpeg.concat` — final video assembly

Four runners. That's it.

---

## Shared preamble (identical across all three flows)

These upstream nodes are flow-independent — every flow starts the same way.
Bundles in the sketch below `extends: 'shared/story_preamble'` rather than
inline this. (Extends is a future feature; for tier 1 just imagine it copied
in.)

```jsonc
{
  "id": "shared/story_preamble",
  "version": "0.1.0",
  "nodes": [
    {
      "id": "plot",
      "kind": "stage",
      "inputs": [{ "from": "user_input", "usage": "context" }],
      "outputs": { "format": "md", "pattern": "plot.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/plot.md", "tier": "MEDIUM" } }
    },
    {
      "id": "story",
      "kind": "stage",
      "inputs": [{ "from": "plot", "usage": "context" }],
      "outputs": { "format": "md", "pattern": "story.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/story.md", "tier": "HEAVY" } }
    },
    {
      "id": "story_essence",
      "kind": "stage",
      "inputs": [{ "from": "story", "usage": "context" }],
      "outputs": { "format": "json", "pattern": "story_essence.json" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/story_essence.md", "tier": "MEDIUM" } }
    },
    {
      "id": "character",
      "kind": "collection",
      "itemSource": "story",
      "inputs": [
        { "from": "story",         "usage": "context" },
        { "from": "story_essence", "usage": "context" }
      ],
      "outputs": { "format": "md", "pattern": "characters/{{id}}.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/character.md", "tier": "MEDIUM" } }
    },
    {
      "id": "setting",
      "kind": "collection",
      "itemSource": "story",
      "inputs": [
        { "from": "story",         "usage": "context" },
        { "from": "story_essence", "usage": "context" }
      ],
      "outputs": { "format": "md", "pattern": "settings/{{id}}.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/setting.md", "tier": "MEDIUM" } }
    },
    {
      "id": "world_style",
      "kind": "stage",
      "inputs": [
        { "from": "story",   "usage": "context" },
        { "from": "setting", "usage": "context", "scope": "all" }
      ],
      "outputs": { "format": "md", "pattern": "world_style.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/world_style.md", "tier": "MEDIUM" } }
    },
    {
      "id": "scene",
      "kind": "collection",
      "itemSource": "story",
      "inputs": [
        { "from": "story",         "usage": "context" },
        { "from": "character",     "usage": "context", "scope": "all" },
        { "from": "setting",       "usage": "context", "scope": "all" },
        { "from": "story_essence", "usage": "context" }
      ],
      "outputs": { "format": "md", "pattern": "scenes/{{id}}.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/scene.md", "tier": "HEAVY" } }
    },
    {
      "id": "character_image",
      "kind": "collection",
      "itemSource": "character",
      "inputs": [
        { "from": "character",   "usage": "context" },
        { "from": "world_style", "usage": "context" }
      ],
      "outputs": { "format": "image", "pattern": "characters/{{id}}.png" },
      "runner": {
        "tool": "comfy.run",
        "config": {
          "manifest": "workflows/built-in/zimage_standard.manifest.json",
          "inputs": { "positive_prompt": "{{character.visual_description}}" }
        }
      }
    },
    {
      "id": "setting_image",
      "kind": "collection",
      "itemSource": "setting",
      "inputs": [
        { "from": "setting",     "usage": "context" },
        { "from": "world_style", "usage": "context" }
      ],
      "outputs": { "format": "image", "pattern": "settings/{{id}}.png" },
      "runner": {
        "tool": "comfy.run",
        "config": {
          "manifest": "workflows/built-in/zimage_standard.manifest.json",
          "inputs": { "positive_prompt": "{{setting.visual_description}}" }
        }
      }
    }
  ]
}
```

---

## Flow A — Shot-by-Shot Klein (current production)

The current narrative template, expressed as a bundle. Each scene fans out
into shots; each shot generates an image; each image becomes a clip.

```jsonc
{
  "id": "flow/shot_by_shot_klein",
  "version": "0.1.0",
  "extends": "shared/story_preamble",
  "nodes": [
    {
      "id": "shot_breakdown",
      "kind": "collection",
      "itemSource": "scene",
      "inputs": [
        { "from": "scene",       "usage": "context" },
        { "from": "world_style", "usage": "context" }
      ],
      "outputs": { "format": "json", "pattern": "scenes/{{scene_id}}/shots.json" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/shot_breakdown.md", "tier": "HEAVY" } }
    },
    {
      "id": "shot",
      "kind": "collection",
      "itemSource": "shot_breakdown",
      "inputs": [{ "from": "shot_breakdown", "usage": "context", "scope": "matching" }],
      "outputs": { "format": "md", "pattern": "scenes/{{scene_id}}/shots/{{shot_id}}.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/shot_prompt.md", "tier": "MEDIUM" } }
    },
    {
      "id": "shot_image",
      "kind": "collection",
      "itemSource": "shot",
      "inputs": [
        { "from": "shot",            "usage": "input" },
        { "from": "character_image", "usage": "reference", "scope": "matching" },
        { "from": "setting_image",   "usage": "reference", "scope": "matching" }
      ],
      "outputs": { "format": "image", "pattern": "scenes/{{scene_id}}/shots/{{shot_id}}_first.png" },
      "runner": {
        "tool": "comfy.run",
        "config": {
          "manifest": "workflows/built-in/flux2_klein_edit_local.manifest.json",
          "inputs": { "positive_prompt": "{{shot.image_prompt}}" }
        }
      }
    },
    {
      "id": "shot_image_last_frame",
      "kind": "collection",
      "itemSource": "shot",
      "inputs": [
        { "from": "shot",       "usage": "input" },
        { "from": "shot_image", "usage": "reference", "scope": "matching" }
      ],
      "outputs": { "format": "image", "pattern": "scenes/{{scene_id}}/shots/{{shot_id}}_last.png" },
      "runner": {
        "tool": "comfy.run",
        "config": {
          "manifest": "workflows/built-in/flux2_klein_edit_local.manifest.json",
          "inputs": { "positive_prompt": "{{shot.last_frame_prompt}}" }
        }
      }
    },
    {
      "id": "shot_video",
      "kind": "collection",
      "itemSource": "shot",
      "inputs": [
        { "from": "shot",                  "usage": "context" },
        { "from": "shot_image",            "usage": "input", "scope": "matching" },
        { "from": "shot_image_last_frame", "usage": "input", "scope": "matching" }
      ],
      "outputs": { "format": "video", "pattern": "scenes/{{scene_id}}/shots/{{shot_id}}.mp4" },
      "runner": {
        "tool": "comfy.run",
        "config": {
          "manifest": "workflows/built-in/ltx23_fml2v_local.manifest.json",
          "inputs": {
            "positive_prompt": "{{shot.motion_directive}}",
            "first_frame": "{{shot_image}}",
            "last_frame":  "{{shot_image_last_frame}}"
          }
        }
      }
    },
    {
      "id": "final_video",
      "kind": "stage",
      "inputs": [{ "from": "shot_video", "usage": "input", "scope": "all" }],
      "outputs": { "format": "video", "pattern": "final.mp4" },
      "runner": { "tool": "ffmpeg.concat", "config": {} }
    }
  ]
}
```

**Strain check:** clean. Every node maps 1:1 to an artifact the user thinks
about. `scope: 'matching'` does the heavy lifting for the per-scene /
per-shot fan-out. Schema doesn't crack.

---

## Flow B — Prompt Relay (LTX 4-segment)

Shots are still authored (the breakdown drives the per-beat prompts) but
**shot videos collapse**: one Comfy call per scene renders all four shots
as one continuous clip. The 4-shot constraint is a property of the workflow
(`ltx23_promptrelay_4seg_local`), not of the bundle.

```jsonc
{
  "id": "flow/prompt_relay_ltx",
  "version": "0.1.0",
  "extends": "shared/story_preamble",
  "nodes": [
    // shot_breakdown + shot + shot_image identical to Flow A — omitted for brevity
    // (in tier-1 paper test, copy from above; the *interesting* divergence is below)

    {
      "id": "scene_relay_prompt",
      "kind": "collection",
      "itemSource": "scene",
      "inputs": [
        { "from": "scene", "usage": "context" },
        {
          "from": "shot",
          "usage": "aggregate",
          "scope": "matching",
          "aggregate": { "strategy": "join", "sep": " | ", "limit": 4 }
        }
      ],
      "outputs": { "format": "json", "pattern": "scenes/{{scene_id}}/relay_prompt.json" },
      "runner": {
        "tool": "llm.generate",
        "config": { "prompt": "prompts/ltx_relay_director.md", "tier": "HEAVY" }
      }
    },
    {
      "id": "scene_clip",
      "kind": "collection",
      "itemSource": "scene",
      "inputs": [
        { "from": "scene_relay_prompt", "usage": "context" },
        {
          "from": "shot_image",
          "usage": "input",
          "scope": "matching",
          "aggregate": { "strategy": "list", "limit": 4 }
        }
      ],
      "outputs": { "format": "video", "pattern": "scenes/{{scene_id}}/clip.mp4" },
      "runner": {
        "tool": "comfy.run",
        "config": {
          "manifest": "workflows/built-in/ltx23_promptrelay_4seg_local.manifest.json",
          "inputs": {
            "global_prompt":   "{{scene_relay_prompt.global}}",
            "local_prompts":   "{{scene_relay_prompt.locals_joined}}",
            "segment_1_image": "{{shot_image[0]}}",
            "segment_2_image": "{{shot_image[1]}}",
            "segment_3_image": "{{shot_image[2]}}",
            "segment_4_image": "{{shot_image[3]}}"
          }
        }
      }
    },
    {
      "id": "final_video",
      "kind": "stage",
      "inputs": [{ "from": "scene_clip", "usage": "input", "scope": "all" }],
      "outputs": { "format": "video", "pattern": "final.mp4" },
      "runner": { "tool": "ffmpeg.concat", "config": {} }
    }
  ]
}
```

**Strain check — REAL FRICTION HERE.** Three issues surfaced:

1. **Variable-N segment cardinality.** The 4-shot count is **not** a property
   of the prompt-relay technique — it's a property of *this specific
   workflow file* (`ltx23_promptrelay_4seg_local`), which appears to be
   bounded by hardware (a 3060 caps out around 1000 frames total). A user
   with better hardware would author an 8-segment variant; a user with
   worse, 2 segments. So the design implication: **the workflow manifest
   declares its segment cardinality**, the bundle says "feed all matching
   shot_images into the segment slots," and a load-time validator confirms
   the upstream count fits the workflow's declared range. Manifests need a
   new field like:
   ```jsonc
   {
     "id": "segment_image",
     "type": "image",
     "cardinality": { "kind": "indexed", "min": 2, "max": 8 }
   }
   ```
   And `parameterMappings` needs to express "bind input N → nodeId from a
   repeating group" rather than 4 hard-coded entries.

2. **The `aggregate` usage is new.** The original schema had three usages
   (context / reference / input); `aggregate` is the fourth. I added it
   because "pack N upstream items into one downstream call" is structurally
   different from a normal dependency. Worth a beat to decide if this is the
   right primitive or a smell. Lean toward keeping it — it's the same shape
   audio (N narration lines → one TTS call) and ffmpeg (N clips → one
   concat) will need.

3. **Indexed slot binding via cardinality expansion.** Instead of hand-coding
   `{{shot_image[0]}}`…`{{shot_image[3]}}`, the binding becomes a template
   over the workflow's declared indexed slot:
   ```jsonc
   "inputs": {
     "segment_image[i]": "{{shot_image[i]}}"
   }
   ```
   where `i` ranges over whatever the workflow's manifest says it accepts.
   New template syntax, but it's the *only* place positional addressing
   leaks into the bundle.

**Sharing implication worth flagging now:** if Alice authors an 8-segment
LTX bundle on a 4090 and shares it with Bob on a 3060, Bob's hardware
can't run it. Manifests probably need a `hardwareHint` field, and the
share/install flow should warn (or auto-fall-back to a smaller-N variant).
Not blocking for tier 1, but worth a note.

---

## Flow C — Seedance T2V

Pure text-to-video. No shot images, no Comfy. Each scene is one API call.

```jsonc
{
  "id": "flow/seedance_t2v",
  "version": "0.1.0",
  "extends": "shared/story_preamble",
  "nodes": [
    {
      "id": "scene_t2v_prompt",
      "kind": "collection",
      "itemSource": "scene",
      "inputs": [
        { "from": "scene",       "usage": "context" },
        { "from": "world_style", "usage": "context" },
        { "from": "character",   "usage": "context", "scope": "matching" },
        { "from": "setting",     "usage": "context", "scope": "matching" }
      ],
      "outputs": { "format": "md", "pattern": "scenes/{{scene_id}}/t2v_prompt.md" },
      "runner": { "tool": "llm.generate", "config": { "prompt": "prompts/seedance_t2v.md", "tier": "HEAVY" } }
    },
    {
      "id": "scene_clip",
      "kind": "collection",
      "itemSource": "scene",
      "inputs": [{ "from": "scene_t2v_prompt", "usage": "input" }],
      "outputs": { "format": "video", "pattern": "scenes/{{scene_id}}/clip.mp4" },
      "runner": {
        "tool": "seedance.t2v",
        "config": {
          "model": "seedance-1.0-pro",
          "duration": 5,
          "resolution": "1080p",
          "prompt": "{{scene_t2v_prompt}}"
        }
      }
    },
    {
      "id": "final_video",
      "kind": "stage",
      "inputs": [{ "from": "scene_clip", "usage": "input", "scope": "all" }],
      "outputs": { "format": "video", "pattern": "final.mp4" },
      "runner": { "tool": "ffmpeg.concat", "config": {} }
    }
  ]
}
```

**Strain check:** also clean. The whole `shot_*` family is absent — bundles
simply don't declare nodes they don't use. `character_image` and
`setting_image` from the preamble are still produced but not referenced —
fine, they're either skipped (unreferenced nodes have no runtime cost) or
the preamble itself is parameterized to skip image generation when no
downstream node consumes it. Lean toward the latter — "the preamble should
know what its consumers need" — but that's a real schema decision worth
calling out.

This raises a clean question: **should the preamble be one fixed bundle, or
should each flow extend a leaner preamble with only what it needs?** For
seedance you want story + scene + character (as text) but probably not
character images. Argues for multiple preamble bundles (`story_text_only`,
`story_with_visuals`) rather than one mega-preamble with conditional logic.

---

## Composing capabilities by editing dependencies

The real test of the dependency-first model is whether new capabilities
land as **additive edits**, not new flows. Two examples.

### Adding audio to the Klein flow

Two surgical changes — one new node, one edge added to an existing node:

```jsonc
// 1. New node
{
  "id": "shot_audio",
  "kind": "collection",
  "itemSource": "shot",
  "inputs": [
    { "from": "shot",      "usage": "context" },
    { "from": "character", "usage": "context", "scope": "matching" }
  ],
  "outputs": { "format": "audio", "pattern": "scenes/{{scene_id}}/shots/{{shot_id}}.mp3" },
  "runner": {
    "tool": "tts.elevenlabs",
    "config": { "voice_map": "{{character.voice_id}}", "text": "{{shot.dialogue}}" }
  }
}

// 2. shot_video gains one dependency
{
  "id": "shot_video",
  "inputs": [
    /* existing: shot, shot_image, shot_image_last_frame */,
    { "from": "shot_audio", "usage": "input", "scope": "matching" }
  ],
  "runner": {
    "tool": "comfy.run",
    "config": {
      "manifest": "workflows/built-in/ltx23_fml2v_with_audio_local.manifest.json"
      // swapped to a workflow whose manifest declares an `audio` input slot
    }
  }
}
```

No new flow. No new template. The backward walker sees `final_video →
shot_video → shot_audio` and just runs it. A user who doesn't want audio
deletes those two pieces; the walker never visits `shot_audio` so nothing
runs.

### Adding pose conditioning to the Klein flow

Same shape:

```jsonc
// 1. New node
{
  "id": "shot_pose",
  "kind": "collection",
  "itemSource": "shot",
  "inputs": [
    { "from": "shot",            "usage": "context" },
    { "from": "character_image", "usage": "reference", "scope": "matching" }
  ],
  "outputs": { "format": "image", "pattern": "scenes/{{scene_id}}/shots/{{shot_id}}_pose.png" },
  "runner": {
    "tool": "comfy.run",
    "config": { "manifest": "workflows/built-in/openpose_estimator.manifest.json" }
  }
}

// 2. shot_image gains one dependency
{
  "id": "shot_image",
  "inputs": [
    /* existing: shot, character_image, setting_image */,
    { "from": "shot_pose", "usage": "reference", "scope": "matching" }
  ],
  "runner": {
    "tool": "comfy.run",
    "config": {
      "manifest": "workflows/built-in/flux2_klein_with_pose_local.manifest.json"
      // swapped to a workflow whose manifest declares a `pose_ref` slot
    }
  }
}
```

Non-pose flow = drop the `shot_pose` node + drop the dep. Bundle authoring
becomes "draw the dependency edges you want." This is exactly what
backward-walking gives you for free.

### Sharing model: complete graphs only, never fragments

A natural-sounding move would be to share "patches" — "here's how I wire
audio into Klein" as a small node-plus-edge diff. Resist this. **Each
shared graph must be idempotent: it runs as-is, with no need to
reconstruct base + patch + version-compatibility state.** Reasons:

- **Application ambiguity** — a patch requires the recipient to have
  exactly the right base at exactly the right version with no
  conflicting patches already applied.
- **Merge conflicts** — two patches that both touch `shot_video`'s deps
  force a human merge decision; complete graphs sidestep the question.
- **Non-determinism** — "what graph is actually running?" should never
  require reconstructing a chain of patches.
- **Versioning rot** — patches need a base-compatibility range, which is
  classic dep hell.

A user who wants Klein + audio authors a new complete graph called
`klein-with-audio`. Bigger on the wire, unambiguous to run.
`derivedFrom: 'klein-narrative@0.3'` is fine as **metadata** — it tells
viewers the lineage without affecting execution.

Composition (drag-and-drop an audio node onto a canvas) is an
**authoring-time** concern in the editor. The editor mutates the graph
in memory; the saved artifact is always a complete graph. Same reason
container images won over patches for deployment: the artifact you ship
is the artifact that runs.

### What this implies for the schema

Nothing extra. The dependency-first model is **already** what `inputs[]`
expresses. The only thing that changes is the framing: the schema isn't
defining pipelines, it's defining a directed graph that gets walked
backward from a goal. The four runners (`llm.generate`, `comfy.run`,
`seedance.t2v`, `ffmpeg.concat`) plus the cardinality/aggregate primitives
discussed above cover every example I can come up with — audio, pose,
multi-shot relay, T2V, future tricks we haven't seen yet.

The one thing this makes much clearer: **the "preamble" concept I
introduced earlier is wrong.** There's no preamble. There are nodes with
dependencies; whichever nodes the backward walk doesn't reach simply
don't run. Seedance doesn't need `character_image` because nothing
downstream depends on it. The "lean preamble vs mega-preamble" debate
dissolves — declare every node you have, the walker prunes what's
unreachable.

## What we learned from this paper test

**Schema mostly holds.** The four runners (`llm.generate`, `comfy.run`,
`seedance.t2v`, `ffmpeg.concat`) absorb all three flows, and manifests
already exist for the workflows. Almost zero new infrastructure.

**Two genuine new primitives surfaced:**

1. **`aggregate` usage** — packing N upstream items into one downstream
   call. Needed for prompt relay (4 shots → 1 video), almost certainly
   needed for audio (N narration lines → one TTS call), and for ffmpeg
   concat. Worth adding to the core schema.

2. **Cardinality reconciliation** — workflows declare fixed input
   cardinality (`segment_1..4_image`), upstream collections produce
   variable counts. Need a load-time validator that catches mismatches
   before the executor runs anything.

**Resolved by the dependency-first framing:**

- **Preamble granularity** — moot. There is no preamble. Declare nodes;
  backward walk prunes unreachable ones. Seedance simply doesn't reach
  `character_image`, so it doesn't run. Klein does reach it. Same bundle
  library, different goal node, different effective graph.

**What did NOT break:**

- Custom Loras / fine-tunes / new Comfy workflows — entirely a manifest
  swap, no bundle change
- New backends (seedance) — just a new runner name
- Audio (sketched but not written) — same `aggregate` primitive
- Scope semantics (`matching`, `all`, `any`) — held up across all three
  flows without modification

---

## Runner self-description (pressure test)

The four runners (`llm.generate`, `comfy.run`, `seedance.t2v`,
`ffmpeg.concat`) have very different parameter surfaces. The agent needs
to do three things with them:

1. **Validate** bundle params at load time — catch "you wrote `tier: HEAVY`
   but the runner expects lowercase" before anything runs.
2. **Edit on demand** — "set scene 3's duration to 8 seconds" requires
   resolving the node, finding its runner, looking up the `duration`
   knob's type and constraints, and applying.
3. **Suggest swaps** — "you're using `comfy.run` with the LTX i2v
   workflow; want to try `seedance.t2v` instead?" requires knowing which
   runners produce the same output type and which params translate.

If runners can't *describe themselves*, all three collapse into a giant
switch statement in agent code, and every new community-shared runner
requires a code change. That defeats the whole point. Self-description
is load-bearing.

### Schema

```ts
interface RunnerDescription {
  id: string;                              // 'seedance.t2v'
  displayName: string;
  description: string;                     // for LLM + UI

  capabilities: string[];                  // ['text_to_video', 'image_to_video']
  modalities: {
    input:  Array<'text' | 'image' | 'video' | 'audio'>;
    output: Array<'text' | 'image' | 'video' | 'audio'>;
  };

  inputs: JSONSchema;                      // standard JSON Schema for config
  outputs: { format: 'image'|'video'|'audio'|'text'|'json' };

  costHint?: 'free' | 'paid_api' | 'local_gpu' | 'cloud_gpu';
  hardwareHint?: { vramGb?: number; durationSecondsP95?: number };

  // For runners that further parameterize on config (comfy.run):
  resolveInputs?: (config: unknown) => JSONSchema;

  // Optional runtime check for dependent constraints:
  validate?: (config: unknown) => { ok: true } | { ok: false; error: string };
}
```

### Pressure point 1 — `comfy.run` is layered, not flat

The runner doesn't have static params; its params come from whatever
manifest the bundle points at. So `comfy.run.inputs` is just
`{ manifest: string, inputs: object }`, and the *real* schema for
`inputs` comes from the manifest's `inputRequirements`. Hence
`resolveInputs(config)` — give it the bundle config (with the manifest
path), get back the effective JSON Schema.

**Verdict: doesn't break.** It's lazy two-level schema resolution. Agent
walks runner → manifest → effective input schema. The manifests we
already have cover this; nothing new to author.

### Pressure point 2 — cross-runner equivalence (harder than it looks)

"Swap LTX i2v for seedance" requires knowing which params are
semantically the same. `prompt` is universal. `seed` is universal.
Beyond that it gets ugly fast:

- **Same concept, different parameterization.** Seedance expresses
  video length as one number (`duration` in seconds). LTX expresses the
  same concept as two derived numbers (`total_frames` + `fps`). A
  simple per-param tag like `x-semantic: 'duration'` can't be placed on
  any single LTX param — neither one alone *is* duration.
- **Mode-conditional concepts.** `image_strength` (or `init_strength`,
  `image_cfg`, etc.) only makes sense in I2V mode. A seedance T2V swap
  must drop it; a seedance I2V swap should preserve it. The agent has
  to know which mode of the target runner it's swapping into.
- **Unit & range mismatch.** Even when concepts align (seed, cfg, etc.),
  one runner's `seed: int32` is another's `seed: int64`; one's `cfg:
  1-10` is another's `cfg: 0-20`. Tag-only matching misses these.

Doing this properly requires three layers of machinery:

- **Concept-level taxonomy** (not just param names): `duration_seconds`,
  `image_guidance`, `random_seed`.
- **Composite + computed mappings**: `LTX.duration_seconds =
  total_frames / fps`, and the inverse to write back.
- **Mode awareness**: each runner declares operating modes; concepts
  are scoped to modes.

That's a lot of machinery for an operation users perform rarely. Two
honest paths forward:

- **(a) Build the full machinery** if cross-runner swaps are a primary
  workflow (editor "try this with a different backend" button, agent
  suggestions like "want me to try seedance instead?").
- **(b) Drop `swap_runner` as an agent verb entirely.** Cross-runner
  work becomes an editor-time activity: user re-authors with the new
  runner. Semantic tags survive only as *optional metadata* — for
  documentation, UI form labels, and suggestion-only behavior. No
  conversion logic, no composite tags, no mode-scoped taxonomy.

**Recommendation: (b).** Path (a) is real but speculative — we don't
have evidence users want one-click cross-runner swaps badly enough to
pay the complexity. The other three agent verbs work without any of
this. Revisit if/when there's real user demand.

### Pressure point 3 — dependent constraints

"Seedance max duration depends on the model you chose." JSON Schema
supports `if/then/else` but it's ugly enough that humans won't author
it correctly. Simpler split:

- **Static schema** (`inputs` field) for shape, types, simple ranges
- **Runtime validator** (`validate(config)`) for the messy dependent
  rules: returns `{ ok, error? }`, agent surfaces the error

Most runners won't need `validate`; only the gnarly ones (Comfy
workflows with conditional slots, API runners with model-dependent
limits) opt in.

### Pressure point 4 — override layering

Four layers, lowest to highest:

1. **Runner default** (in `inputs` JSON Schema `default`)
2. **Manifest default** (workflow manifests already have `defaultValues`)
3. **Bundle node `config`** value (the graph author's choice)
4. **Agent override** (per-run, transient — "use duration 8 just for
   this regen")

Effective value at runtime = highest-set layer wins. Validation runs on
the merged result. `override_param` agent op writes layer 3 (persistent)
or layer 4 (one-shot redo). Both go through the same JSON Schema +
`validate()` check.

### Pressure point 5 — where self-description LIVES

Options:

- TypeScript module exports a `Runner` object with a `describe()` method.
  Types are the source of truth; JSON manifests are emitted at build.
- Hand-authored JSON manifest next to the runner code (mirrors the
  workflow manifest pattern).
- Runtime registration (`registerRunner({...})` at module load).

**Pick TypeScript-first.** Why: runners are TS modules anyway, types
catch divergence at compile time, JSON manifests can be emitted at build
for fast listing in the editor without importing runner code. The
workflow manifests are different — they describe Comfy graphs, not TS
modules, so hand-authoring is unavoidable there.

### What this means for the agent's tool surface

With self-description in place, the agent's verbs stay narrow:

```
redo(node_id, reason?)
override_param(node_id, param_path, value)      // validated against runner schema
override_content(node_id, file_path)            // user-supplied artifact
```

Three verbs. They work on *any* graph because they reference node ids
and use runner self-description for everything else. No runner-specific
agent code. New community runner installed? Agent picks it up the
moment its `describe()` is loaded — same property MCP gives you.

(A fourth `swap_runner` verb was considered but dropped, see pressure
point 2 — cross-runner equivalence needs too much speculative
machinery for the value it delivers. Runner swaps stay in the editor.)

### What does NOT work without self-description

- **Editor UI cannot render param forms** — would have to hand-code a
  form per runner.
- **Agent cannot help users tweak params** — would need hardcoded
  knowledge of every runner.
- **Community runners can't be safely shared** — recipient's agent has
  no idea what knobs they expose.
- **Bundle validation degrades to "did the runner exist?"** — no
  type/range/enum checking until runtime, which is where errors are
  most expensive.

So self-description isn't a nice-to-have; it's the load-bearing piece
that makes the whole sharing story work.

## Swapping generators (Flux → Nano Banana Pro, etc.)

The practical test of "extensible architecture" is: how easy is it for a
user to swap the underlying model behind a node? E.g. Flux ↔ Nano Banana
Pro ↔ SDXL ↔ Ideogram for images; LTX ↔ Wan ↔ Hunyuan ↔ Seedance ↔ Kling
↔ Veo for video.

Three tiers of swap difficulty:

### Tier 1 — Swap within an existing runner (minutes, zero code)

If both generators are accessible via the same runner (e.g. both run as
ComfyUI workflows), swap is **a single field change in the bundle**:

```jsonc
// Before:
"runner": {
  "tool": "comfy.run",
  "config": { "manifest": "workflows/built-in/flux2_klein_edit_local.manifest.json", ... }
}

// After:
"runner": {
  "tool": "comfy.run",
  "config": { "manifest": "workflows/user/nano_banana_pro.manifest.json", ... }
}
```

In an editor, this is a dropdown. Bundle is saved as a new complete graph
(per the "complete graphs only" decision). Done.

### Tier 2 — Author a new workflow + manifest (hours, one-time, no code)

If the generator isn't yet in the user's manifest library, the user (or
someone in the community) authors the Comfy workflow JSON + manifest. Once
authored and shared, everyone gets tier 1.

This is real work but it's **authoring**, not coding. The manifest format
(`inputRequirements` + `parameterMappings`) is already what
`workflows/built-in/*.manifest.json` use.

### Tier 3 — Add a new backend (half-day, one-time per service, code)

If the generator is API-only (no ComfyUI integration), someone writes a
new TypeScript runner — maybe 100-200 lines:

1. Take config from the bundle node
2. Call the service's API
3. Save the result to the node's output path
4. Return `{ ok, path }`
5. Export a `RunnerDescription` (self-description block)

Once written and registered, every bundle author gets tier-1 access.
**This is the MCP analogue**: a developer writes the server once; normal
users install + use.

### What this means for end-user UX

| User type | Action | Cost |
|-----------|--------|------|
| Picks pre-built generator | Dropdown in editor | Minutes |
| Imports community workflow | Drop file, point bundle at it | Minutes-to-hours |
| Adopts new cloud service | Wait for someone to ship a runner | Half-day (one developer, one time) |

The bottleneck moves from "edit core code" (today) to "someone shipped a
runner package once" (new model). Same shift that made MCP useful.

### Compared to today

Today, swapping the image generator means modifying
`executeShotImageLastFrame.ts` and `shotImagePipeline.ts`, adding a new
branch in the image-gen path, and risking regressions in the existing
flow. Probably 1-2 days of careful work for a developer who knows the
codebase, and the change is local to this repo only — no one else
benefits.

In the new model: tier 1 = minutes for a user, tier 3 = half-day for a
developer once, ever, and that work is shareable. That's the practical
win.

### The honest caveat — model behavior, not architecture

The architecture makes swapping *mechanically* easy. It cannot make
output *semantically equivalent*. Flux wants tag-style prompts; Nano
Banana Pro prefers natural-language descriptions. Swap the runner, the
prompts you authored will produce worse output without rewriting.

Mitigation lives in runner self-description:

```jsonc
{
  "promptStyle": "natural_language",       // or "tag_based" | "either"
  "promptMaxTokens": 4096,
  "supportsNegativePrompt": false,
  "supportedAspectRatios": ["1:1", "16:9", "9:16"]
}
```

Editor uses these to warn on swap: "Flux uses tag-style prompts; Nano
Banana Pro prefers natural language. Want me to ask the LLM to rewrite
your prompts?" Useful UX layer, but the underlying model behavior is
unfixable at the architecture level — and that's true for *any*
architecture, not a property of this one.

## Backward walker — what carries over, what's new, what hurts

The existing `DependencyGraphExecutor.ts` is 990 lines of accumulated
correctness. None of that complexity is bloat — each piece exists because
something broke before it. Before claiming the bundle model "replaces"
this, walk through every concern the existing executor handles and check
whether the bundle model carries it.

### Eight concerns the existing executor solves

| # | Concern | Where it lives today |
|---|---------|----------------------|
| 1 | Partial completion / restart recovery | `fromState`, `resetAbortedNodes` (detects `agent.stop()` / abort markers, resets to pending) |
| 2 | Redo isolation | `invalidateNode` with `cascade`, `cascadeOnlyCompleted`, `preserveFramesOther`, `singleFrame` |
| 3 | Self-heal / failure handling | `markFailed`, `writeFailedAttempt.ts`, retry budgets per node |
| 4 | Collection expansion at runtime | `expandCollection`, `expandMatchingDependent`, called when an item-source node completes |
| 5 | Dependency rewiring after expansion | `rewireMatchingDepsForItem`, `rewireTypeLevelRefsToPerItem` (collapses type-level deps into per-item deps) |
| 6 | Content overrides (user-supplied artifacts) | `contentResolver.ts` checks for override files before running |
| 7 | Stage gates (`/run-to`) and node gates | `isStageGateSatisfied`, `isNodeGateSatisfied` in `stages.ts` |
| 8 | Persistence after every mutation | `onMutation` hook — exists because an early bug dropped expanded collection items on kill |

### How each maps to the bundle / backward-walker model

**Three carry over cleanly — schema does the work:**

- **#1 (restart recovery).** Node status IS the persisted source of truth.
  Resume = re-walk from goal, run any non-terminal node. The `resetAbortedNodes`
  logic stays unchanged — it's about detecting abort markers, not about
  graph shape.
- **#2 (redo isolation).** Backward walk naturally limits invalidation
  blast radius to actual dependents. The four `invalidateNode` options
  remain: `cascade` is BFS through dep edges, `cascadeOnlyCompleted`
  filters by node state, `preserveFramesOther` is a per-runner concern
  (the runner declares which outputs are per-frame), `singleFrame` is
  agent-specified. Schema doesn't change; surface stays the same.
- **#5 (dependency rewiring).** With `scope: 'matching'`, the walker
  resolves "which items of upstream X match item Y of source Z" *at
  walk time*. No graph mutation needed — the rewiring becomes a pure
  function over node ids. **This is a real win** vs the existing
  imperative rewiring. Less state, more derivation.

**Three carry over with a clean surface change:**

- **#6 (content overrides).** Become a layer in the runner-invocation
  protocol: walker checks "is there an override file at the node's
  output path?" before invoking the runner. If yes, mark complete,
  skip the runner. Same pattern, slightly different home.
- **#7 (stage gates).** A gate is just "are all nodes of typeId T
  terminal?". Walker keeps running ready nodes until satisfied. No
  schema change.
- **#8 (persistence after mutation).** Same `onMutation` hook pattern;
  the *thing* being persisted is node status, not bundle definition.
  Bundle is immutable at runtime.

**Two need real new machinery:**

- **#4 (collection expansion).** This is the load-bearing one. The
  walker CANNOT be pure topo-sort + run-ready. It must observe
  completions of `itemSource` nodes, materialize per-item instances
  of any collection node that fans out from them, and *then* re-walk.
  This is iterative reconciliation, not a single pass.

  Concretely: `shot_breakdown` completes with items `[s1, s2, s3]`.
  The walker now needs to materialize `shot_image[s1]`, `shot_image[s2]`,
  `shot_image[s3]`, and downstream `shot_video[s_n]`, `shot_audio[s_n]`,
  etc. The per-item nodes are *new runtime state*; the bundle
  definition says "shot_image is a collection over shot_breakdown" but
  doesn't list s1/s2/s3 (it can't — those don't exist until shot_breakdown
  runs).

  The existing executor handles this. The bundle model must too.

- **#3 (retry policy).** Retry budgets and failure modes are
  runner-specific: LLM gets N retries with exponential backoff; Comfy
  gets one retry on transient socket errors; seedance API has its own
  rate-limit/retry rules. **Retry policy belongs on the runner's
  self-description**, not on the walker. The walker just observes
  "this node failed, runner says retry budget remaining is K" and
  decides.

### The fundamental shape: iterative reconciliation, not topo-sort

The model that fell out of this analysis:

```
loop:
  1. Backward-walk from goal, mark "needed" node types
  2. Materialize per-item instances for any collection whose itemSource
     has completed since the last walk
  3. Compute ready set: nodes whose deps are all complete AND that have
     no override + no terminal status
  4. Apply gates (stage gates, node gates) → maybe pause
  5. Dispatch ready nodes (one or many, in parallel up to runner limits)
  6. On each completion: persist state, return to step 1
  7. On each failure: check runner's retry policy, requeue or mark
     terminal-failed
exit when:
  - All nodes reachable from goal are terminal, or
  - A gate fires, or
  - User aborts (mark in-flight as failed-aborted, persist, exit)
```

The 990 lines of `DependencyGraphExecutor` mostly implement steps 2,
3, 5, 6, 7 with all the corner cases (abort detection, mutation
persistence, dep rewiring during expansion). The bundle model
preserves the shape; the new pieces are:

- A clean runner-dispatch interface (driven by self-description) that
  replaces the hardcoded LLM-only path
- A declarative `scope: 'matching'` resolver that replaces the
  imperative rewiring methods
- Per-runner retry policy as data, not code branches

Nothing here is conceptually new — it's mostly a different *factoring*
of the existing complexity.

### Biggest tier-2 risk

Collection expansion timing is the single most likely place to lose
existing correctness during a rewrite. The existing executor has the
`onMutation` persistence hook specifically because expansion + kill
between expansion and first per-item completion lost data. Any tier-2
shadow executor that doesn't preserve this property will be subtly
broken in ways that don't surface until a real project resumes from a
mid-expansion kill.

**Concrete mitigation for tier 2:** the seedance flow chosen as the
shadow-executor target was a deliberate choice — its only collection
is `scene_clip` over `scene`, fanning out once at the top. No
multi-level fan-out (shot → shot_image → shot_video), no rewiring,
no matching scope across levels. It's the smallest possible test of
the model. If seedance shadow-executes correctly, we have evidence
the basic shape works. We do NOT have evidence the model handles
Klein-style multi-level expansion until we prove that separately —
that's tier 3, and probably needs the full reconciliation loop
implemented before we can claim parity.

## Suggested next step (tier 2) — corrected

Earlier guidance said "do seedance first because it's simpler." That was
based on modeling seedance as T2V-only. **Realistic seedance use is
multi-reference + multi-shot in one API call — structurally identical to
prompt relay.** Both feed N reference images + a multi-beat prompt into
a single backend call that returns one continuous clip.

So the right framing isn't "prompt relay vs seedance as different graphs."
It's **one multi-shot graph, two runners**:

- `bundles/multi_shot_relay_ltx.json` — `scene_clip.runner = comfy.run`
  (LTX local workflow)
- `bundles/multi_shot_relay_seedance.json` — `scene_clip.runner =
  seedance.multi_ref` (ByteDance API)

Two bundles differing in exactly one node's runner block. If both produce
sensible final videos from the same upstream artifacts, the architecture's
central claim ("swap the runner, not the graph") is proven.

Order of work:

1. Build schema + walker + `llm.generate` + `comfy.run` + `ffmpeg.concat`
2. Author the LTX bundle, run end-to-end on a real project
3. Add `seedance.multi_ref` runner, author the seedance bundle, run
4. Compare outputs; document differences

Flow A (Klein shot-by-shot) is parity work — last to migrate, because
it has the most accumulated correctness.
