# Display Capabilities — bundle ↔ desktop contract

The desktop UI must work with any bundle (built-in, third-party, user-authored) without per-bundle code. The contract that makes that possible is **display capabilities**: each bundle node optionally declares a `displayCapability` string in `bundle.json`. The desktop queries the bundle + walkState by capability to discover what artifacts exist and where to find them — it never inspects node ids or filesystem paths directly.

This document is the **registry of reserved capability names** that the dhee-core platform recognises and the desktop ships views for. Bundles MAY use any capability string they want; unknown capabilities are silently ignored by the desktop (graceful degradation — the artifacts are still on disk).

## How a bundle node declares its capability

```json
{
  "id": "shot_image_prompt",            // free-form internal name; not used by desktop
  "kind": "collection",
  "outputs": { "format": "json", "pattern": "prompts/shot_image/{{item_id}}.json" },
  "runner": { "tool": "llm.generate", "config": { ... } },
  "displayCapability": "shot.prompt"    // ← the contract
}
```

## How the desktop queries

```ts
import { findByCapability, listCompletedItemIds } from 'dhee-core/dag';

// Reading project.json from disk; bundle definition from the bundle source resolver
const completedShots = listCompletedItemIds(bundle, project.walkState, 'shot.prompt');
// → ['scene_1_shot_1', 'scene_1_shot_2', ...]

// Or get full instances with their output paths:
const promptNodes = findByCapability(bundle, project.walkState, 'shot.prompt');
for (const cn of promptNodes) {
  for (const inst of cn.instances) {
    if (inst.status === 'completed' && inst.outputPath) {
      // inst.outputPath is the path the runner wrote — bundle-agnostic
    }
  }
}
```

The desktop **never** does `projectDir + '/prompts/shot_image/'` — the path comes from walkState, which is bundle-authoritative.

## Reserved capabilities

### Narrative / planning

| Capability       | What it tags                                  | Output format |
| ---              | ---                                           | ---           |
| `plot.outline`   | High-level beats / plot summary               | md            |
| `story.prose`    | Full narrative prose (the "draft")            | md            |
| `story.essence`  | Tone / genre / narration metadata             | json          |
| `style.world`    | World style / palette / lighting reference    | md            |
| `character.plan` | Cast list with descriptions                   | json          |
| `setting.plan`   | Location list with descriptions               | json          |
| `scene.plan`     | `{scenes: [...], shots: [...]}` breakdown      | json          |

### Per-character / per-setting

| Capability         | What it tags                  | Output format |
| ---                | ---                           | ---           |
| `character.prompt` | Per-character image prompt    | json          |
| `character.image`  | Per-character reference image | png           |
| `setting.prompt`   | Per-setting image prompt      | json          |
| `setting.image`    | Per-setting reference image   | png           |

### Per-shot

| Capability         | What it tags                            | Output format |
| ---                | ---                                     | ---           |
| `shot.prompt`      | Per-shot image-generation prompt        | json          |
| `shot.motion`      | Per-shot motion / video prompt          | json          |
| `shot.first_frame` | Per-shot first-frame image              | png           |
| `shot.last_frame`  | Per-shot last-frame image (FL2V mode)   | png           |
| `shot.last_prompt` | Per-shot last-frame image prompt        | json          |
| `shot.video`       | Per-shot video clip (shot-by-shot mode) | mp4           |

### Scene / final

| Capability            | What it tags                                | Output format |
| ---                   | ---                                         | ---           |
| `scene.video_prompt`  | Per-scene global prompt for relay rendering | md            |
| `scene.video`         | Per-scene assembled clip (relay mode)       | mp4           |
| `final.video`         | Concatenated final video                    | mp4           |

## Conventions

- **Dotted-namespace.** Always use `<domain>.<artifact>` — e.g. `shot.first_frame`, not `firstFrame` or `shot-first-frame`.
- **Domain prefix is plural-of-thing.** Use `shot.` (not `shots.`), `scene.`, `character.`, `setting.` — singular noun.
- **Stable contract.** Once a capability ships in a release, its semantics (what artifact it tags, what format) are immutable. Add new capability names rather than reinterpreting old ones.
- **Custom capabilities are fine.** A user-authored bundle that produces `storyboard.panel` artifacts can tag those nodes with `storyboard.panel`. Desktop views without a handler for that capability ignore them.

## Migrating an existing bundle

The 3 built-in narrative bundles (`narrative_prompt_relay`, `narrative_shot_by_shot`, `narrative_qwen_chain_relay`) all carry their `displayCapability` tags as of feat/dag-bundles. A bundle author migrating their own bundle:

1. Add `displayCapability` to each node in `bundle.json` whose output should appear in the desktop UI.
2. Pick from the reserved set above, or use a custom dotted name.
3. No code changes needed — once the tag is on disk, the desktop sees the artifacts as the project runs.

## Why not infer capability from node id?

Tempting, but brittle: bundles can name nodes anything, and naming conventions drift. Encoding the contract explicitly via `displayCapability` keeps the desktop honest and bundles free to evolve their internal vocabulary.

## The `display` block — tile thumbnail + stats

For the project list / landing tile, bundles also declare what the desktop should put in the thumbnail and what numbers to summarize. This is a top-level `display` block in `bundle.json`:

```json
{
  "id": "narrative_qwen_chain_relay",
  "display": {
    "thumbnail": {
      "from": "shot.first_frame",
      "pick": "first_completed"
    },
    "stats": [
      { "label": "scenes", "source": "scene.plan", "path": "scenes.length" },
      { "label": "shots",  "source": "scene.plan", "path": "shots.length" }
    ]
  },
  "nodes": [...]
}
```

### Thumbnail

- `from` — a capability tag. The desktop finds completed instances of nodes with this capability and uses one's `outputPath` as the thumbnail image.
- `pick` — selection rule when multiple instances match:
  - `first_completed` (default) — lowest-key in lex order; for shot ids that's the opening frame
  - `random_completed` — random pick each landing visit, gives the gallery life
  - `latest_completed` — highest-key in lex order

Capability needs to produce an image-format artifact (png / jpg / webp). Bundles that produce no images (audio-only, text-only) omit the thumbnail block and tiles fall back to a generic icon.

### Stats

An array of `{label, source, ...}` entries. Each entry is one of:

- **`count_completed: true`** — count completed instances of a collection node with capability `source`. Use for "12 tracks", "47 shots", etc.
- **`path: "<dot.path>"`** — read the JSON file at the capability's `outputPath` and extract via dot-path. `foo.length` is array-length sugar. Use for "3 scenes" (scenes.length), "1240 words" (wordCount).

Stats with no matching capability OR unreadable source files are silently skipped.

### Wild bundle examples

A **music album** bundle:

```json
"display": {
  "thumbnail": { "from": "music.cover_art" },
  "stats": [
    { "label": "tracks", "source": "music.track", "count_completed": true },
    { "label": "min",    "source": "music.master", "path": "totalDurationMinutes" }
  ]
}
```

A **text-only novella** bundle (no images):

```json
"display": {
  "stats": [
    { "label": "chapters", "source": "chapter.text", "count_completed": true },
    { "label": "words",    "source": "story.prose",  "path": "metadata.wordCount" }
  ]
}
```

A **3D scan / SAM3D** bundle:

```json
"display": {
  "thumbnail": { "from": "model3d.preview" },
  "stats": [
    { "label": "models", "source": "model3d.mesh", "count_completed": true }
  ]
}
```

The desktop renders all of these without any per-bundle code change.
