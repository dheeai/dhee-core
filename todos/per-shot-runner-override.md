# Per-Shot Runner Override — User-Driven Quality Escalation

## Problem

The bundle architecture (Phases 0–6, on `feat/dag-bundles`) routes every
shot through the bundle's declared default runner. For `narrative_relay`,
that's `comfy.image` (Flux Klein local) for all shot images — cheap and
local, but Klein structurally fails on hard cases:

- Multi-character spatial relationships (one character inside a vehicle,
  another outside)
- Two-character identity simultaneously held against 3+ references
- Tight camera framing + depth-of-field combined with composition demands

The measured cost-quality ladder (memory `project_image_gen_cost_2026_05`):

```
Klein local  $0.014   ❌ structurally fails on multi-character spatial
NB2 Flex     $0.020   ⚠️ soft-deflects violent prompts
NB3 Flex     $0.0345  ✅ nails complex 3-ref scenes
NBP Flex     $0.072   ✅ but refuses violence
```

User intent: *let the agent pick Klein by default, but escalate to NB3
(or NBP for safe content) when the user explicitly says so for a
specific shot.* Example chat exchange:

> User: "Redo shot 1 with NBP."
> Agent: [invalidates shot_image:scene_1_shot_1 with runner=nbp.gen,
>         calls dhee_run_to scope=last_invalidated]
> [shot 1 re-renders via NBP, cost ~$0.072, image preserved]

## Why this needs a small architectural extension

Today the bundle's `node.runner.tool` is a single value applied to
every instance of the node. There's no mechanism for the agent (or
walker) to say "for *this specific* shot instance, use a different
runner."

What we need is a per-instance override stored in `walkState`, set by
`dhee_invalidate`, read by the walker at dispatch time.

## Design

### Schema change: `NodeStateEntry.runnerOverride`

```ts
// src/dag/walkState.ts
interface NodeStateEntry {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  outputPath?: string;
  // NEW: when set, walker uses this runner for this specific instance
  // instead of the bundle node's declared runner.tool. Persists across
  // runs — once set, sticks until another dhee_invalidate clears or
  // changes it.
  runnerOverride?: {
    tool: string;                         // e.g. "nano-banana.gen-3"
    configPatch?: Record<string, unknown>; // merged with the alternate's bundle-declared config
  };
  itemId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}
```

### Bundle schema: `node.alternates` field

The bundle declares the alternates that are valid for each node. This
prevents typo'd runner names from silently failing at render time, and
gives the agent a documented menu it can prompt-engineer against.

```json
{
  "id": "shot_image",
  "kind": "collection",
  "itemSource": "shot_breakdown",
  "runner": {
    "tool": "comfy.image",
    "config": {
      "workflowPath": "workflows/klein.json",
      "endpoint": "self.local"
    }
  },
  "alternates": {
    "nano-banana.gen-3": {
      "displayName": "Nano Banana 3 (Flex)",
      "costHint": 0.0345,
      "description": "Best for multi-character spatial / complex 3-ref scenes",
      "config": {
        "model": "google/gemini-2.0-flash-exp:image-3"
      }
    },
    "nano-banana.gen-p": {
      "displayName": "Nano Banana Pro (Gemini 3 Pro Image)",
      "costHint": 0.072,
      "description": "Highest quality; refuses violent content",
      "config": {
        "model": "google/gemini-3-pro:image"
      }
    }
  }
}
```

Walker reads `alternates` when applying a `runnerOverride`. The
override's `tool` must be either the node's declared default OR a key
in `alternates` — anything else is a hard error at dispatch time with
the valid menu listed.

### Tool change: `dhee_invalidate` accepts `runner` param

The existing `dhee_invalidate` tool stays. New optional field:

```
dhee_invalidate
  nodeId: "shot_image:scene_1_shot_3"     // existing
  runner: "nano-banana.gen-3"              // NEW (optional)
```

When `runner` is set, the tool:
1. Validates the runner is in the node's `alternates` (or matches the default).
2. Writes `runnerOverride` into the walkState entry for that node.
3. Marks the node `pending` (existing behavior).
4. Cascades to downstream dependents (existing).

When `runner` is absent and an override was previously set, the override
is preserved (the user is just invalidating; the runner choice is
sticky). To clear an override, pass `runner: "default"` (or whatever
sentinel we pick — bikeshed in implementation).

### Walker: per-instance runner lookup

```ts
// in walker.ts, when about to dispatch an instance:
const override = state?.nodes[stateKey]?.runnerOverride;
let runnerTool: string;
let runnerConfig: Record<string, unknown>;
if (override) {
  const alt = node.alternates?.[override.tool];
  if (!alt && override.tool !== node.runner.tool) {
    return ok:false with: `runnerOverride '${override.tool}' is not in node '${node.id}'.alternates (valid: ${...})`;
  }
  runnerTool = override.tool;
  runnerConfig = {
    ...(alt?.config ?? node.runner.config),
    ...override.configPatch,
  };
} else {
  runnerTool = node.runner.tool;
  runnerConfig = node.runner.config;
}
const runner = getRunner(runnerTool);
// ... dispatch with the resolved tool + config
```

walkState records which runner actually ran (`metadata.runnerUsed`) so
the agent can answer "which runner produced this shot?" later.

### Agent prompt: cost-quality menu

The pi-agent's prompt (or a tool-description block) gets a generated
section listing the alternates from each node's bundle declaration.
Concretely:

> Image runners available for `shot_image` / `shot_image_last_frame`:
>   - `comfy.image` (Flux Klein, $0.014, default) — fast/cheap; can fail on multi-character spatial
>   - `nano-banana.gen-3` ($0.0345) — preferred escalation; nails complex 3-ref scenes
>   - `nano-banana.gen-p` ($0.072) — highest quality, refuses violent content
>
> When the user asks to redo a shot with a different model, call
> `dhee_invalidate` with the `runner` param, then `dhee_run_to scope=last_invalidated`.

The menu is *data-driven from the bundle*, not hardcoded in the agent
prompt — when a new alternate is added to the bundle JSON, the agent
sees it on next startup without a code change.

### New runner packages

Each non-Klein runner ships as its own SDK-conforming `Runner`:

```
src/dag/runners/
  nb3Gen.ts          # Nano Banana 3 via OpenRouter
  nbpGen.ts          # Nano Banana Pro (Gemini 3 Pro Image)
  comfyImage.ts      # existing — Klein
```

Each declares its own manifest with `credentials` (e.g.
`OPENROUTER_API_KEY`, `GOOGLE_API_KEY`). Bundle dependency validation
runs at walk-entry: if a bundle's `alternates` references a runner
without registered credentials, the validation pre-flight surfaces it
before any work runs.

NB2 is intentionally *not* shipped (per memory
`feedback_image_gen_escalation` — strictly dominated by NB3 for ~$0.015
more, no reason to keep an inferior option in the menu).

## Failure modes to enumerate before writing tests

(per project TDD rule)

1. User asks for a runner not in the node's `alternates` — walker
   rejects with the alternates list named.
2. User asks for a runner whose package isn't installed (credentials
   missing) — bundle validation fails with the env var named.
3. Override set; user doesn't invalidate; next regen accidentally
   reverts — must NOT happen (override is sticky on the walkState
   entry until explicitly changed).
4. Override set; bundle author changes the node's default runner in a
   later version — does the override still apply? Decision needed:
   yes (override wins) until the user clears it.
5. Override set; bundle author REMOVES that runner from `alternates`
   in a later version — walker rejects at dispatch with a clear
   migration message.
6. Cascade from `dhee_invalidate` — does the override apply only to
   the named node, or also propagate to dependents? Decision needed:
   override is scoped to the named node ONLY. Dependents re-render
   with their own defaults.
7. Multiple `dhee_invalidate` calls on the same node with different
   runner params — last one wins.
8. User asks "what runner did shot 3 use last time?" — agent reads
   walkState metadata.runnerUsed.

## Scope estimate (Claude-Code days, per
[[feedback_time_estimates_with_claude_code]])

| Piece | Days |
|---|---|
| Walker reads `runnerOverride` from walkState (+ tests for failure modes 1, 3, 4, 5, 6, 7) | 0.5 |
| `dhee_invalidate` accepts `runner` param (+ validation against alternates) | 0.25 |
| Bundle schema `alternates` field (schema.ts + walker lookup) | 0.5 |
| `nano-banana.gen-3` runner (OpenRouter HTTP, image-multipart upload, image-token billing-aware) | 1.0 |
| `nano-banana.gen-p` runner (mostly forks NB3) | 0.25 |
| Agent prompt: data-driven alternates menu + dhee_invalidate docstring update | 0.25 |
| End-to-end test: `dhee_invalidate runner=nbp.gen` then `dhee_run_to` → image re-renders via NBP | 0.5 |

**Total: ~3 days.** Same shape as the bundle migration —
declarative, single-vocabulary, no glue.

## Dependencies

- Phases 0–6 of the bundle migration must be complete (✅ done as of
  the feat/dag-bundles branch).
- The `narrative_classic` bundle (deferred work) is *not* a hard
  prerequisite — this feature is independently valuable on
  `narrative_relay`'s `shot_image` nodes.

## What this unlocks

- The first piece of platform UX where the user iteratively tunes
  the project through chat: "redo this one with NBP," "now make
  shot 4 cheaper with Klein," "show me which runners were used."
- A foundation for ANY per-instance config override, not just runner
  selection — future overrides could include workflow variant,
  reference image set, sampling params, etc.
- A worked-example template for the future
  `~/.kshana/runners/<thing>/` ecosystem — NB3 and NBP are the first
  built-in non-Comfy runners and exercise the SDK boundary.

## Out of scope (deliberately)

- Automatic VLM-judge + retry escalation (no LLM auto-decides to bump
  to NB3). Manual user instruction only. Auto-escalation is a future
  feature once we have data on which judge thresholds correlate with
  user reroll requests.
- A web-UI runner picker. Chat-driven via the agent only for v1.
- Cost budgeting / spend caps. The user gets a per-image cost hint in
  the agent's response; running a budget meter is a separate feature.
