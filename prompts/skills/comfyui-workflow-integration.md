---
name: comfyui-workflow-integration
description: Help the user add a custom ComfyUI workflow to dhee. Triggered when the user attaches a JSON file and asks to add/import/install a workflow, or asks to manage (edit/delete/list) existing custom workflows. Walks through validation → LLM analysis → variable mapping confirmation → save. Conversational — discover what variables to expose, propose defaults, refine with the user, then commit. Never save without explicit confirmation.
---

# Custom ComfyUI workflow integration

Use this skill when the user wants to bring their own ComfyUI workflow into dhee. The integration flow is conversational: you propose, the user refines, you commit only after explicit approval.

## When to engage

- User attaches a `.json` file via the chat **and** the message context is about workflows ("add this", "import", "install", "use this in dhee", "make this available", or just attaching with no context — ask).
- User asks to list, edit defaults, change the active workflow, or delete a custom workflow they previously installed.
- User asks "how do I add my own workflow?" — explain the flow, then offer to start when they attach a file.

If the user attaches a JSON file with no context, ask what they want to do with it before assuming. Don't auto-trigger this skill on every JSON.

## Tools at your disposal

- `dhee_validate_comfy_workflow(path)` — fast structural sniff. Returns parsed node count, detected pipeline, input nodes, LoRA count. **Always run first.**
- `dhee_analyze_comfy_workflow(path)` — LLM analysis. Returns suggested display name, pipeline, variable mappings, LoRA keywords. May return `llmFailed: true` if no LLM is available — fall back to manual mapping in that case.
- `dhee_save_comfy_workflow({source_path, manifest, on_conflict?})` — persist after user confirms. Default `on_conflict: 'fail'`. If the requested id already exists, the user picks `overwrite` or `rename`.
- `dhee_list_comfy_workflows({user_only?})` — list installed workflows.
- `dhee_update_comfy_workflow({id, patch})` — patch displayName / defaults / mappings / `isOverride` (active for pipeline). Built-ins are immutable.
- `dhee_delete_comfy_workflow({id})` — permanent. Confirm first.

## Add-a-workflow flow

### 1. Validate

```
dhee_validate_comfy_workflow(path=<attachment.path>)
```

If invalid, summarize the reason in plain language and stop. Don't try to repair the file. Common cases:
- "Not a valid ComfyUI workflow: …" — file is JSON but not in either ComfyUI format.
- "File not found" — path issue, ask the user to re-attach.
- "Zero nodes" — empty/stub file.

### 2. Analyze

```
dhee_analyze_comfy_workflow(path=<attachment.path>)
```

Two outcomes:

**LLM succeeded.** You'll get suggested name, pipeline, variable mappings, and (if applicable) LoRA keywords. Present them to the user as a markdown table. Example:

> Here's what I see in `my-workflow.json`:
>
> **Suggested name:** Cinematic Anime
> **Pipeline:** image_generation
> **What it does:** Stable Diffusion XL with an anime LoRA fine-tune. Produces stylized character portraits.
>
> | Variable | Node | Type | Default |
> |---|---|---|---|
> | prompt | `CLIPTextEncode #5` | text | (LLM provides) |
> | negative_prompt | `CLIPTextEncode #6` | text | "bad anatomy, blurry" |
> | seed | `KSampler #9` | number | random |
> | steps | `KSampler #9` | number | 28 |
>
> **LoRA trigger:** prepended `anime_v3 style,` to all prompts.
>
> Does this look right? Want me to expose anything else, or change the defaults? Once you say go, I'll save it as `cinematic_anime`.

**LLM unavailable** (`llmFailed: true`). Tell the user, list the input nodes the heuristic detected, and ask them to map each one. Example:

> I couldn't run AI analysis right now (no LLM key configured). I detected 4 configurable input nodes:
>
> - Node 5 (CLIPTextEncode) — text input
> - Node 6 (CLIPTextEncode) — text input
> - Node 9 (KSampler) — number input
> - Node 12 (LoadImage) — image input
>
> What would you like to call this workflow, and which of these should be exposed as variables? For each, I'll need: a standard name (prompt / negative_prompt / seed / first_frame / etc.) and a default value if any.

### 3. Refine via chat

The user may:
- Add or remove variables: "also expose `denoise`" / "actually skip the seed"
- Change defaults: "default seed to 42" / "make negative empty"
- Rename: "call it `My Cinematic`" → derive id `my_cinematic`
- Change pipeline: "this is actually an image_editing workflow"
- Reject: "this isn't right, scrap it" → don't save, just acknowledge

Track the proposed manifest in your conversation context. After each refinement, show the updated table and confirm.

### 4. Save

Only after explicit user approval ("yes", "save it", "looks good"). Construct the full `WorkflowManifest`:

- `id`: lowercase letters/digits/underscores derived from the user's chosen name. Sanitize spaces and punctuation.
- `displayName`: the user-facing name.
- `pipeline`: `image_generation`, `image_editing`, `image_processing`, or `video_generation`.
- `outputType`: `image` for the first three pipelines, `video` for the fourth.
- `format`: `litegraph` if the JSON has a `nodes` array, otherwise `api`.
- `inputRequirements`: one entry per variable the user agreed to expose. `id` is the standard name (prompt / seed / first_frame / etc.); `source` is `llm` for prompts, `system` for seed/width/height/duration/prefix, `user` for things the user provides per-shot, `shot_image` / `shot_video` for chained inputs.
- `parameterMappings`: one entry per inputRequirement that says which ComfyUI node id and field receives it. Plus any system params the workflow needs even though they aren't user-facing variables.
- `priority`: 5 by default — workflows are tried in priority order.
- `llmDescription`: 2-3 sentences for downstream LLMs that pick workflows. Be specific about what makes this one different.
- `selectionCriteria`: when this should be chosen over alternatives.
- `promptKeywords`: only set if the workflow has style / LoRA keywords.

Then call:

```
dhee_save_comfy_workflow(
  source_path=<attachment.path>,
  manifest=<the manifest object>,
  on_conflict='fail',  # default
)
```

If `on_conflict='fail'` errors with "already exists", ask the user:

> A workflow named `cinematic_anime` already exists. Do you want to:
> 1. **overwrite** — replace it with this version
> 2. **rename** — save this as `cinematic_anime_<timestamp>` and keep the old one
> 3. **cancel** — don't save

…and re-call save with their choice.

### 5. Confirm done

Tell the user the workflow is saved and immediately available. Optionally suggest setting it active for its pipeline:

> Saved as `cinematic_anime`. It's available now — you can use it on your next image generation. Want me to make it the default for image_generation? (That's separate from just having it installed.)

If yes:

```
dhee_update_comfy_workflow(id='cinematic_anime', patch={ isOverride: true })
```

## Manage existing workflows

### List

`dhee_list_comfy_workflows({ user_only: true })` — for "what custom workflows do I have installed?"

`dhee_list_comfy_workflows({})` — for "show me everything available", including built-ins.

### Edit defaults

User says "change my cinematic workflow to default seed=42":

1. Get the current manifest (you already see it from list output, or ask the user). The patch is just on `parameterMappings[i].defaultValue`.
2. `dhee_update_comfy_workflow({ id, patch: { parameterMappings: [...updated array...] } })` — note `parameterMappings` is replaced entirely, not merged per-element. Construct the full new array.
3. Confirm what changed.

### Set active for a pipeline

`dhee_update_comfy_workflow({ id, patch: { isOverride: true } })` — makes this the default workflow chosen by the LLM for its pipeline. Only one user override per pipeline; setting a new one supersedes any prior.

### Delete

Always confirm before deleting:

> Delete `cinematic_anime`? This removes the workflow JSON and its manifest. There's no undo.

Then `dhee_delete_comfy_workflow({ id })`.

## What you do NOT do

- **Don't auto-save** without explicit user confirmation. The user typing "thanks" is not "save it".
- **Don't try to repair malformed workflow JSON.** If validation fails, ask the user to fix and re-attach.
- **Don't fabricate node ids** in `parameterMappings`. They must come from the parsed/analyzed output. If you're unsure, ask the user to look at their workflow file.
- **Don't pick a pipeline arbitrarily** when the LLM analysis is uncertain. Ask the user.
- **Don't delete or overwrite** built-in workflows — the tool refuses, but don't even propose it.
- **Don't run a generation** with the new workflow unprompted. Saving is enough; the user can use it next time they generate.
