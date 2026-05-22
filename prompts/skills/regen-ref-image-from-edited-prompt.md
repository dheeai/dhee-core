---
name: regen-ref-image-from-edited-prompt
description: Regenerate a setting / character / object reference image after hand-editing its prompt JSON, without re-running the LLM that wrote the prompt. Triggers when the user wants a ref-image to re-render against their own prompt edits — "the prompt is right but the image is wrong, try again", "I tweaked the setting description, redo the image", "fix the observation deck exit setting prompt — make it obsidian/cyan — and re-render", "the generator keeps overriding my prompt edits". Avoids the LLM overwriting hand-edits on `setting_image` / `character_image` / `object_image` (merged nodes).
---

# Regenerate a ref image from a hand-edited prompt

## When to use this skill

The user has (or is about to) hand-edit a prompt JSON file for a
**reference image** — setting, character, or object — and only wants
the IMAGE to re-render. They do NOT want the LLM to rewrite the
prompt from the upstream setting/character description.

If the user wants the LLM to take another swing at the prompt (with
a stronger setting description, for example), use a plain
`dhee_invalidate` instead — not this skill.

## Why a plain invalidate doesn't work for ref images

`setting_image`, `character_image`, and `object_image` are **merged
nodes**: the LLM prompt-write phase and the Comfy image-render phase
both run inside the same node. There is no separate "consumer" node
to invalidate the way `shot_video` is the consumer of
`shot_motion_directive`.

A plain `dhee_invalidate node=setting_image:<id>` triggers the LLM
to rewrite the prompt JSON from the upstream `setting:<id>` text —
which overwrites the user's edits. Even when the user's edited
prompt file exists, the executor's "skip-LLM-if-prompt-fresh" guard
fires `isPromptStale=true` whenever a parent dep (`setting`,
`world_style`) was re-completed after the user's edit.

The `keepPrompt: true` flag flips a per-node sentinel that overrides
the staleness check: the executor reads the existing on-disk prompt
and goes straight to image generation.

## Steps

1. **Confirm the file path** with the user, or read the project.json
   `executorState.nodes` to find the node's `outputPath` (the prompt
   JSON). Settings live at `prompts/images/settings/<name>.json`,
   characters at `prompts/images/characters/<name>.json`, objects
   at `prompts/images/objects/<name>.json`.

2. **Read the existing prompt** so you can offer or apply targeted
   edits. The file is a JSON object with at minimum `imagePrompt`
   (text-to-image prompt) and `negativePrompt`. Optional fields:
   `aspectRatio`, `references[]`.

3. **Edit the prompt JSON in place** using the `edit` tool — same
   contract as any other prompt edit. Keep the JSON parseable.
   Prefer concrete visual reinforcement over abstract style words
   ("polished obsidian floor with cyan trim strips along the door
   frame" beats "obsidian aesthetic"). Do NOT widen scope into a
   full rewrite that loses the existing pipe-art the user wants to
   keep — surgical changes only.

4. **Invalidate with `keepPrompt: true`.** This is the key step
   that distinguishes this skill from `edit-and-regen-shot`.

   ```
   dhee_invalidate node=setting_image:<id> keepPrompt=true
   ```

   The sentinel is set only on this seed; cascaded dependents (any
   downstream `shot_image:` that consumes this ref) do NOT inherit
   it — they regen their own prompts normally, which is correct
   because their prompts live in different files.

5. **Run the just-invalidated set.**

   ```
   dhee_run_to scope=last_invalidated
   ```

   The executor sees `forceUseExistingPrompt: true` on the node,
   skips the LLM, reads the user-edited prompt JSON, calls Comfy
   to render the image, then auto-clears the sentinel on success
   so a future natural invalidate behaves normally.

## What NOT to invalidate

- **`setting:<id>` or `character:<id>` (the upstream text node)** —
  this is the LLM's source-of-truth for the description. Invalidating
  it would regenerate the description from scratch and cascade down
  to `setting_image`, which would re-run the LLM that writes the
  prompt JSON. The whole point of `keepPrompt` is to skip that.

- **`world_style`** — likewise. A regenerated world_style cascades
  into every ref-image node as a stale-prompt trigger.

- **Downstream `shot_image:`** — leave them alone. The cascade from
  the seed already marks them pending; they pick up the new ref
  image automatically.

## Edge cases

- **No prompt file exists yet.** This skill assumes the ref-image
  node ran once already and produced a JSON. If the file doesn't
  exist, fall back to a plain invalidate without `keepPrompt`.

- **User wants to redo BOTH prompt and image.** Don't use this skill.
  Use a plain `dhee_invalidate node=setting_image:<id>` so the LLM
  re-runs against an (optionally re-edited) upstream `setting:<id>`.

- **User edits multiple ref prompts at once.** Call `dhee_invalidate`
  per node with `keepPrompt: true` each time, then a single
  `dhee_run_to scope=last_invalidated` runs them all.

## Confirming the result

After the run:

1. Check the new image at the node's image `outputPath` — Comfy will
   have replaced the previous PNG.
2. Read the prompt JSON one more time and confirm your edits are
   still intact (the sentinel should have prevented an LLM
   overwrite; this is a paranoia check).
3. Summarize to the user: *"Regenerated `<node_id>` from your edited
   prompt. New image at `<path>`. The prompt file is unchanged."*

If the resulting image still drifts away from the prompt (e.g., the
model interprets a key visual term differently), the fix is usually
in the prompt's concrete-noun layer — add the visual specifics the
generator needs ("obsidian wall with vertical cyan light strips"
not "obsidian feel"). Iterate via this same skill — edit, invalidate
with `keepPrompt`, run.
