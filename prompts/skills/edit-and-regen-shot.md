---
name: edit-and-regen-shot
description: Apply a creative change to a single shot or frame by editing its prompt file in-place and regenerating just that node. Triggers when the user asks for a tweak to one specific shot/frame ("make s1 shot 3's last frame have her hands tied", "change the lighting on s2 shot 5 to dawn", "redo s1 shot 1 with a wider angle"). Avoids running the whole pipeline.
---

# Edit and regenerate one shot

Use this when the user asks for a creative change to **one specific
shot or frame** — not for project-wide stylistic changes (those need
`scene_video_prompt` resets) and not for fresh starts (those use
`dhee_run_to`).

## Steps

1. **Load the right craft skill BEFORE you write.** A bad prompt is
   the leading cause of bad regens. Pull in:
   - **image-prompting** — for any change to `imagePrompt` (rules
     for composition, character/setting naming conventions, style
     cues, what the generator needs).
   - **video-direction** — for any change to `motionDirective`
     (camera vs subject motion, timing, transition vocabulary).

   These hold the same craft instructions the original generation
   pipeline used. Without them you'll lose character continuity,
   break reference markers, or produce prompts the generator
   misinterprets.

2. **Read the prompt file.** Use the `read` tool on:
   - `prompts/images/shots/scene-<N>-shot-<M>.json` — for image
     prompt changes (first/last/mid frames).
   - `prompts/motion/scene_<N>_shot_<M>.json` — for motion-directive
     changes that affect the rendered video.

   Note the path conventions differ:
   - **image prompts**: hyphens, in a `shots/` subfolder
   - **motion prompts**: underscores, no `shots/` subfolder

3. **Modify the right field.** For image prompts, the structure is
   ```
   { frames: { first_frame: { imagePrompt, references, ... },
               last_frame:  { imagePrompt, references, ... } } }
   ```
   Edit only `frames.<frame>.imagePrompt`. Keep `references`,
   `generationMode`, and other fields exactly as they are — they
   pin the visual identity. Apply the rules from `image-prompting`:
   name characters and settings directly in the prose; the
   `references` array (refId + imageNumber) does the binding.

   For motion prompts, the file is `{ motionDirective: "..." }`.
   Replace the string per `video-direction` guidance.

4. **Write the file back** with `write` (or `edit` if it's a small
   targeted change). The new JSON must remain valid.

5. **Trigger the regen** with `dhee_invalidate` + `dhee_run_to`.

   ### Per-shot node taxonomy (memorize this)

   Each shot lives as four independent nodes in the dep graph. Pick the
   right one(s) for what the user is asking for:

   | Node id (per shot) | Produces | Cascades down to |
   |---|---|---|
   | `shot_image_prompt:scene_N_shot_M` | The image-prompt JSON (LLM writes prose) | image, last_frame, video, final_video |
   | `shot_image:scene_N_shot_M` | The **FIRST FRAME** image | last_frame, video, final_video |
   | `shot_image_last_frame:scene_N_shot_M` | The **LAST FRAME** image (independent edit of first frame) | video, final_video |
   | `shot_motion_directive:scene_N_shot_M` | The motion-directive text | video, final_video |
   | `shot_video:scene_N_shot_M` | The per-shot video clip | final_video |

   ### Intent → invalidate (the common cases)

   | User asks for… | Invalidate | Why this and not something else |
   |---|---|---|
   | "Redo the **whole shot**" (re-roll the shot from scratch) | `shot_image:scene_N_shot_M` AND `shot_image_last_frame:scene_N_shot_M` | First-frame invalidation cascades to last_frame anyway, but you should invalidate BOTH explicitly so the executor regenerates both with the LATEST prompt rather than relying on cascade semantics. Both → video → final_video. |
   | "Redo **only the last frame**" (keep first frame, get a different end state) | `shot_image_last_frame:scene_N_shot_M` | This is the surgical case. First frame stays as-is; last frame re-renders against the existing first frame as base; the video re-stitches with the new last frame. |
   | "Redo **only the first frame**" (rare — almost always the user wants whole-shot) | `shot_image:scene_N_shot_M` | First frame regen cascades the last frame (because last_frame depends on first_frame). If the user genuinely wants a different first frame without touching the last, that's not a supported op — confirm with the user; usually they mean "whole shot". |
   | "Redo **just the video**" (frames are fine, motion is wrong) | `shot_video:scene_N_shot_M` | Frames stay. Video re-renders from existing frames + the (possibly updated) motion directive. |
   | "Redo the **image prompt** (creative rewrite — let LLM redo prose)" | `shot_image_prompt:scene_N_shot_M` | Producer regen — the LLM rewrites the prose, then everything downstream re-renders. Use only when you want the LLM to author from scratch; if you already hand-wrote the prompt see the consumer-vs-producer table below. |

   Call `dhee_invalidate node=<id>` once per node you need to invalidate
   (the tool takes ONE node at a time). For "whole shot" that's two
   calls — first `shot_image:…`, then `shot_image_last_frame:…`. After
   both are invalidated, `dhee_run_to scope='last_invalidated'` runs
   exactly the right set including the cascaded video + final_video.

   ### Producer-vs-consumer (for hand-edited files)

   **Principle: you wrote it → don't invalidate it. Invalidate the
   consumer instead.** Every node represents an LLM call that produces
   a file. Invalidating a node re-runs that LLM, which writes a fresh
   file and overwrites whatever you just wrote. To force downstream
   regeneration of the things that *consume* your hand-written file,
   invalidate the consumer node(s) — not the node whose file you
   touched.

   File you just wrote → invalidate this consumer:

   | You wrote                                          | Invalidate                            | Don't invalidate (producer)               |
   |----------------------------------------------------|----------------------------------------|--------------------------------------------|
   | `prompts/images/shots/scene-N-shot-M.json` (imagePrompt) | `shot_image:scene_N_shot_M` (+ `shot_image_last_frame:…` if last_frame's imagePrompt also changed) | `shot_image_prompt:scene_N_shot_M` |
   | `prompts/motion/scene_N_shot_M.json`               | `shot_video:scene_N_shot_M`            | `shot_motion_directive:scene_N_shot_M`     |
   | A first frame PNG (hand-replaced)                  | `shot_image_last_frame:scene_N_shot_M` AND `shot_video:scene_N_shot_M` | `shot_image:…`                              |
   | A last frame PNG (hand-replaced)                   | `shot_video:scene_N_shot_M`            | `shot_image_last_frame:…`                  |

   After invalidating, run `dhee_run_to scope='last_invalidated'`.
   The regenerated asset surfaces as a media card in the chat as it
   lands on disk — you don't need to call `dhee_show_*` after.

## What NOT to do

- **Don't invalidate the node whose file you just wrote.** That node's
  producer is an LLM; invalidating it makes the executor re-run that
  LLM on the next dispatch, which writes a fresh file and silently
  overwrites your text. If you wrote
  `prompts/motion/scene_N_shot_M.json` and then call
  `kshana_invalidate node=shot_motion_directive:scene_N_shot_M`, your
  motion directive will be gone by the time the video renders. Use the
  consumer-mapping table in step 5 — for a hand-written motion
  directive, invalidate `shot_video:…`; the video re-renders from your
  text and the directive file stays untouched.
- **Don't stage the new prompt in a sidecar / `_new` / `.draft` file.**
  The pipeline reads the canonical filename only — anything you write
  to `scene-<N>-shot-<M>_new.json` or similar is invisible to the
  executor. If you want to propose a change before committing, paste
  the proposed JSON into the chat as a code block and wait for the
  user's "go" — do NOT touch the filesystem until then. Once approved,
  overwrite the actual prompt file path (step 4) and run the regen
  (step 5). Half-applied edits leave the project in a confusing state
  where the preview shows the old prompt and there's a mystery file
  on disk no one wired in.
- Don't rewrite the entire prompt file from scratch — preserve the
  scaffolding (references, generationMode, schema fields).
- Don't run `dhee_run_to <stage>` for a single-shot change — that
  re-executes every shot.
- Don't call `dhee_invalidate stage=<upstream>` (plot, story,
  characters, setting, scene, world_style, scene_video_prompt) — that
  wipes wide swaths of generated content. Always invalidate the
  smallest scope that gets the job done; for a single shot edit that
  scope is one `node=`.

## Confirming the result

After `dhee_run_to scope='last_invalidated'` finishes:

1. **Call `dhee_describe_image`** on the regenerated frame, passing
   the prompt you just edited as `expectedPrompt`. The VLM tells you
   whether the new image actually reflects the edit (or whether the
   regen drifted, lost a reference, etc.).
2. **Summarize for the user.** Either "✓ regen matches the new prompt
   — <one-line description>" or "✗ regen still shows X — likely
   cause Y, want me to retry?". Don't just say "done — does it look
   right?" without having looked yourself.
3. If the user wants another iteration, repeat steps 1–4 of this
   skill with their next change.

Skip step 1 only if `dhee_describe_image` returns "VLM not
configured" — in that case fall back to `dhee_show_*` + asking
the user.
