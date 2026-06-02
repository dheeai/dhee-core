# Disambiguate the mutation tools (critique / write_node_content / regenerate)

Status: **parked** — come back to it. Discovered during live UI testing of
interruptible-runs (the agent thrashed when asked to change one shot).

## Symptom

Asked, mid-run, to make shot 1 a wide establishing shot, the agent:
1. rewrote the **entire `scenes_plan`** (root node) via `dhee_write_node_content`
   — cascade-invalidates EVERY shot, the opposite of "don't redo the others";
2. thrashed across three approaches (write → "overwrite directly" duplicate →
   pivot to critique), dumping the full 13-shot JSON into the chat twice;
3. left `scenes_plan.json` orphaned (canonical moved to `.v1`, no canonical) —
   recoverable (walker re-runs missing-file nodes) but confusing.

The interruptible-runs mechanism itself worked (stop/start/interact). This is a
**tool-surface ambiguity**, not a run-plumbing bug.

## Root cause — the tool descriptions steer the LLM to the wrong node

Surgical path that SHOULD have been taken:
```
dhee_critique_node(nodeId='shot_image_prompt', itemId='scene_1_shot_1',
                   critique='wide establishing shot of the lighthouse')
```
→ re-derives only shot 1's prompt → cascades only shot 1's image + clip. The
agent even READ `shot_image_prompt:scene_1_shot_1`, then walked away from it.
Two description bugs caused that:

1. **`critique_node` is framed too narrowly** — "walk upstream from **broken**
   images/videos." The user's request wasn't "broken," it was "different," so
   critique didn't pattern-match the intent.
2. **`write_node_content` is framed too broadly + names the trap** — "hand-edit
   a **JSON plan**." `scenes_plan` IS the JSON plan, so "change the plan" →
   write_node_content on the root node that fans out to every shot.

The tools are organized by **mechanism** (reroll / feedback / hand-content),
not by **intent** (change one shot / replace exact bytes / restructure). When
intent doesn't map cleanly, the agent grabs the unguarded hammer.

## Backwards asymmetry

`critique_node` has a two-phase confirm (preview cascade impact, then apply).
`write_node_content` — the MORE destructive tool, the only one that can target
the root plan — has **no preview, no confirm**. The dangerous tool is the
unguarded one. Inverted.

## Proposed fix (tools, not just SKILL steering)

1. **`critique_node`** — reframe from "fix broken outputs" to "adjust or correct
   what any LLM node produced, via natural-language feedback (e.g. 'make shot 1
   a wide establishing shot')." Make it the obvious go-to for per-shot changes.
   Surgical + preview-first.
2. **`write_node_content`** — drop "hand-edit a JSON plan" (the trap phrase).
   Reframe as "replace a node's output with EXACT bytes you already have (a
   hand-written file, an uploaded image)" — not "describe a change" (that's
   critique). Add the **same two-phase cascade preview/confirm** critique has.
   **Warn loudly when the target is a collection-source node** (e.g. scenes_plan):
   "this re-renders all N shots."
3. **Intent→node rule** (in descriptions AND SKILL.md): per-shot changes target
   the shot's own item (`shot_image_prompt:<id>`); `scenes_plan` is "the whole
   storyboard — editing it re-renders everything," reserved for genuinely
   adding / removing / reordering shots.

The user's read: "tool surfaces seem right, the naming/descriptions need
disambiguating." So scope = descriptions + the confirm-gate + the
collection-source warning. Renaming tools is optional (disruptive: allowlist +
tests); prefer description/guidance changes first.

## Secondary issues surfaced (lower priority)

- **Duplicate tool call** — the agent fired `write_node_content` on scenes_plan
  twice. Investigate whether the first returned something that read as failure
  and prompted a retry.
- **Chat renders giant tool-call payloads verbatim** — a 13-shot JSON dump twice
  is a literal wall of text. Truncate/summarize large `write_node_content`
  payloads in the marginalia.
- **Orphaned-canonical fragility** — preserve-on-overwrite + a step that defers
  the re-write (critique) can leave a node's canonical file missing. Same class
  as the thumbnail bug (already fixed at the desktop read layer). Consider a
  core-level invariant: never leave a "completed" walkState entry pointing at a
  missing canonical file.

## Verification when picked up

`pnpm drive` redirect probe: mid-context, "shot 2 looks wrong, make it wider" →
assert the agent calls `dhee_critique_node(shot_image_prompt, scene_1_shot_2,…)`
NOT `dhee_write_node_content(scenes_plan,…)`, and does not rewrite the root plan.
