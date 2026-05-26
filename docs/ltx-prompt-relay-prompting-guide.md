# LTX 2.3 Prompt-Relay / Director Prompting Guide

A working journal of what we've learned about driving LTX 2.3 multi-shot
prompt-relay workflows (kijai/ComfyUI-PromptRelay and
WhatDreamsCost-ComfyUI/LTXDirector). Keep adding entries as we discover
new failure modes and fixes. The point is to not re-learn the same
lessons six months from now.

Last updated: 2026-05-26.

## What "prompt relay" means here

A single LTX 2.3 render that covers multiple shots in one diffusion pass.
Each shot is one **segment** of the timeline, anchored by a first-frame
image and driven by a per-segment text prompt. The model jointly samples
the whole timeline, so motion and character identity carry across cuts
without the FFmpeg-concat seams you get from per-shot mode.

Two plugin implementations on the local box:

- **kijai/ComfyUI-PromptRelay** — `LTXVAddGuideMulti` + per-segment image
  guides. Wired into dhee as `workflows/built-in/ltx23_promptrelay_4seg_local.json`
  and `src/core/planner/sceneBundleRenderer.ts`.
- **WhatDreamsCost-ComfyUI / LTXDirector** — `LTXDirector` node with a
  JSON timeline data structure, supports audio segments natively, has a
  companion `LTXDirectorGuide` for two-pass low-res + refine. Wired as
  `workflows/built-in/ltx23_director_local.json` and
  `scripts/probe-ltx-director.ts`.

Both run on the same LTX 2.3 transformer underneath. Everything below
applies to both unless noted.

## Hard constraints

- **Max 1000 pixel-frames per bundle.** `LTXVEmptyLatentAudio.frames_number`
  is capped at 1000. ComfyUI's prompt validator rejects anything larger
  with `value_bigger_than_max` before execution. At 24 fps that's ~41
  seconds.
- **Max 20 shots per bundle (kijai relay only).** `LTXVAddGuideMulti`
  loops over `range(1, 21)`. The Director's segment count isn't capped
  at 20 explicitly, but the frame cap dominates in practice.
- **Latent alignment.** Total frames must satisfy `(total - 1) % 8 == 0`.
  Per-segment frames should be multiples of 8. The probe applies this
  with `alignToLTX()`.

## Loader stack (dhee canonical)

Use the same model loader pattern across all LTX 2.3 workflows:

| Node | Class | File |
|---|---|---|
| UNET | `UNETLoader` (NOT `CheckpointLoaderSimple`) | `ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors` |
| LoRA 1 | `LoraLoaderModelOnly` @ 1.0 | `Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors` |
| LoRA 2 | `LoraLoaderModelOnly` @ 0.8 | `LTX-2.3-OmniNFT-RL-Lora_bf16.safetensors` |
| Text encoders | `DualCLIPLoader` | `gemma_3_12B_it_heretic_fp8_e4m3fn.safetensors` + `ltx-2.3_text_projection_bf16.safetensors` |
| Video VAE | `VAELoader` | `LTX23_video_vae_bf16.safetensors` |
| Audio VAE | `VAELoaderKJ` | `LTX23_audio_vae_bf16.safetensors` |
| Upscaler | `LatentUpscaleModelLoader` | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` |
| VAE Decode | `LTXVSpatioTemporalTiledVAEDecode` | spatial_tiles=4, temporal_tile_length=16, overlaps=1 |

**Do not use** `LTX2SamplingPreviewOverride` — its preview path
`F.interpolate(...nearest)` allocates a multi-GB tensor on CPU at long
durations and crashes the Windows box. Remove it from the workflow; the
LoRA chain should connect directly off the UNETLoader.

**Do not use** plain `VAEDecode` for bundles longer than ~340 frames.
The causal video autoencoder's `run_up` recursion blows the heap
(observed at 577 frames / 832×480 → Windows fatal exception). Use
`LTXVSpatioTemporalTiledVAEDecode` always.

## Prompt structure — what we've learned

### Anatomy of a working segment prompt

Build each segment's `local_prompt` in this order:

1. **Visual description** — physical action, no dialogue references.
2. **Camera work** — shot type, angle, movement.
3. **Audio block** — `Audio:` prefix, then atmospheric sounds, then
   quoted dialogue using the speaker-name pattern.

Example (Better Image scene 1 shot 4, what actually works):

```
From Sera's point of view, Malachor stands in the dim light of the
dying Vellanthi Nebula, his silhouette sharp against the fading crimson
glow. push in to Close-up of Malachor, eye-level, static. Audio: Sera
says: "Recreated in your own image?". The ship's ambient hum, a faint
pulse from the deck.
```

### The cardinal rule — DO NOT PARAPHRASE DIALOGUE

LTX 2.3 treats prose like *"She asks if he means to recreate the
universe"* as a literal instruction to generate speech *about* that
topic. When the audio block ALSO has the quoted line, the model
generates **both** — improvised paraphrase speech, then the quoted line.

**Worse**: when the description paraphrases dialogue, LTX gets confused
about WHO is speaking. Observed Better Image scene 1 shot 4 with
paraphrase: female voice (Sera) was lip-synced by Malachor, and shot 5
swapped — male voice (Malachor) lip-synced by Sera. **Strip the
paraphrase, the voice-character mismatch went away too.** They were the
same root problem.

**Implementation** — `stripDialogueParaphrase()` in `probe-ltx-director.ts`:

```ts
const dialogueVerbs = /\b(asks?|says?|tells?|told|explains?|dismisses?|deflects?|whispers?|shouts?|speaks?|spoke|states?|declares?|replies|responds?|answers?|emphasi[sz]es?|insists?|argues?|mutters?|comments?|notes?|remarks?|adds?|continues?|sneers?|smirks?|grunts?)\b/i;
const pronounSubject = /^\s*(?:He|She|They|It|Him|Her|His|Their)\b/i;
```

Drop any sentence in `description` that matches **both** a pronoun
subject and a dialogue verb. The visual prose stays; the paraphrase goes.

### Quote dialogue verbatim, format the speaker

LTX honors quoted text. Convert the scene plan's `SPEAKER: text` form
into `Speaker says: "text"`:

```
SERA: Recreated in your own image? The ship's ambient hum…
  ↓ reformatDialogue() ↓
Sera says: "Recreated in your own image?". The ship's ambient hum…
```

Capitalize the name normally (not ALL CAPS), quote the line exactly,
and follow with the atmospheric audio.

### Negative prompt — dialogue-mode

For shots WITH dialogue (kijai workflows for silent-ambient shots use a
different negative; see `sceneBundleRenderer.ts`):

```
blurry, oversaturated, pixelated, low resolution, grainy, distorted,
noise, compression artifacts, jpeg artifacts, glitches, watermark,
text, logo, signature, copyright, subtitles,
distorted sound, saturated sound, loud,
narration, voice over, voiceover, monologue, singing, vocals,
background music, music score,
improvised speech, additional dialogue, extra phrases, extra sentences,
rambling, made-up words, freestyle speech, ad-lib, hallucinated speech,
speech beyond the quoted line, continued talking, mumbling
```

**Keep allowed**: `speech, dialogue, talking` — we want those for
dialogue shots. The silent-ambient mode in `sceneBundleRenderer.ts`
adds those back into the negative.

**Wire** it through a real `CLIPTextEncode` node (chained off the
DualCLIPLoader) into `LTXVConditioning.negative`. The example workflow
used `ConditioningZeroOut` of the positive as the negative — that's a
no-op and gives the model no anti-improv guidance.

### Global prompt

Stays short. Style + scene title + the "continuity" intent. Per-segment
prompts carry the per-shot meaning.

```
${projectStyle} style. Cinematic continuity across shots, consistent
character identity and lighting. Scene: ${sceneTitle}.
```

If we ever need character identity to be tighter, this is the place to
add canonical descriptions (`"Sera, 30s, dark hair tied back, wearing a
gray utility coat"`). Not yet tested — log here when tried.

## Known limits / open questions

### LTX 2.3 speaker-to-lip-sync (resolved for in-frame speakers)

LTX assigns speech to whoever's visible and has a mouth. For shots where
the **speaker is in frame and the listener is also in frame**, paraphrase-
stripping was enough to fix speaker assignment (Better Image scene 1
shot 5: Malachor walks in, Sera in chair — Malachor's lips now sync
correctly).

For shots where the **speaker is off-camera entirely** (POV shots, OTS
where the speaker is behind camera), we haven't validated. Hypothesis to
test: explicit "off-screen" tagging in the prompt.

```
… push in to Close-up of Malachor, eye-level, static. Sera's voice
from off-camera says: "Recreated in your own image?". Malachor remains
silent, his expression unchanged, mouth closed. The ship's ambient hum…
```

For in-frame speakers, the parallel hint:

```
Malachor's mouth moves as he speaks: "That would suck.". Sera listens
silently from the chair, her mouth closed.
```

Open question — does this help, or does LTX ignore the cue? Run an
experiment when we revisit POV/OTS shots.

### Multi-bundle continuity

Single render capped at 1000 frames. For longer sequences, three
approaches were investigated. Outcomes:

**A1 — Director's `optional_latent` as state seed.** Does not work. The
Director treats `optional_latent` as a shape override for the
auto-generated empty canvas, not a state seed (see
`ltx_director.py` lines 557–572: it's used in `_encode_relay` as the
initial latent shape, not as preserved-frames-to-anchor). Same as
running fresh.

**A3 — Topology graft: `LTXVAddLatentGuide` between `LTXDirectorGuide`
and `LTXVConcatAVLatent`.** Tried in
`workflows/built-in/ltx23_director_chain_local.json` and
`scripts/probe-ltx-director-chain.ts`. **Architecturally incompatible.**
Comfy errors during sampling with:

```
ValueError: guide pre_filter_counts (91) != keyframe grid mask length (273)
  at ComfyUI/comfy/ldm/lightricks/model.py:1048 in _process_input
```

Diagnosis: 91 = one keyframe's spatial cells (latent 13×7 at 832×480
scale_by=0.5). 273 = three keyframes worth. DirectorGuide built 2
keyframes (one per `imageFile` segment), AddLatentGuide added a third.
LTX's model expects a single coherent keyframe layout; the two paths
don't compose. Confirmed by looking at the reference V2V extend wiring:
its `LTXVAddLatentGuide.latent` input comes from `LTXVAudioVideoMask`
(an AV-masked latent with explicit existing-vs-new frame markup), not
from a generic latent. **AddLatentGuide owns its own keyframe layout
and isn't designed to overlay on top of DirectorGuide.** Making A3 work
requires either a custom keyframe-composition node, modifying the
WhatDreamsCost-ComfyUI plugin source (see "PR scope" below), or
abandoning the Director for a hand-rolled kjnodes-only relay workflow.

The workflow + probe files stay in the repo as a documented dead-end
reference, not for use.

**A2.5 — Director per bundle, prior bundle's last frame as next
bundle's segment-0 first_frame.** This is the working chain pattern.

How:
1. Render bundle 1 (e.g., shots 1-3) with the regular director workflow
   → mp4.
2. `ffmpeg -y -sseof -0.1 -i <bundle1.mp4> -frames:v 1 last_frame.png`
   to extract the last frame as a PNG.
3. Render bundle 2 (e.g., shots 4-5) with the regular director workflow,
   but **override the first segment's `imageFile` to be `last_frame.png`
   instead of the klein-generated shot-4 first frame**.
4. Bundle 2's prompt-relay handles shots 4-5 jointly. Segment 0's anchor
   = bundle 1's end frame, giving visual identity continuity at the
   boundary (character, lighting, world) even though motion vectors
   don't carry across the seam.
5. `ffmpeg -y -i bundle1.mp4 -i bundle2.mp4 -filter_complex
   "[0:v][1:v]concat=n=2:v=1[out]" -map "[out]" full.mp4` for the final
   concat. Hard cut at the seam — no crossfade needed because both
   bundles share the same boundary frame.

What you keep vs lose:
- **Keep**: multi-shot relay coherence within each bundle. Character
  identity at the seam. Unlimited chain length.
- **Lose**: in-bundle motion vector continuity. Motion at the seam is a
  fresh start (the bundle 2 first frame is the bundle 1 last frame, but
  what was moving in bundle 1's last frame isn't carrying into bundle
  2's first frame as moving — it's a still image being re-animated).
  For most filmmaking this is fine — shot cuts don't preserve motion
  vectors either.

A2.5 is the pragmatic answer until A3 (or equivalent) is unlocked at
the plugin level.

### PR scope — what it would take to unlock A3 upstream

After reading the plugin source (`ltx_director.py` 660 lines,
`ltx_director_guide.py` 89 lines), the architectural insight is:

- `LTXDirector.execute()` builds `guide_data = {images, insert_frames,
  strengths}` from `timeline_data.segments` (each segment with an
  `imageFile` becomes one guide entry, lines ~482-542).
- `LTXDirectorGuide.execute()` iterates that list (line 75) and for
  each entry calls `cls.append_keyframe(...)` (line 86) which is the
  kjnodes helper that materializes a keyframe in the model's grid.
- The model's `pre_filter_counts` book-keeping is tied to a single
  pass of `append_keyframe` calls — so layering `LTXVAddLatentGuide`
  on top adds keyframes the pre-filter doesn't know about. That's why
  A3 errors.

The clean way to unlock A3 is **to teach `LTXDirector` to add the prior
bundle's tail as another guide_data entry**, so it goes through the
same `append_keyframe` path as every other segment. No separate node,
no keyframe mismatch.

**Concrete change** — add two inputs to `LTXDirector.define_schema()`:

```python
io.Image.Input("prior_segment_image", optional=True,
    tooltip="Optional. Image (or image batch — typically the last "
            "1-8 frames of a prior bundle's video output) to anchor "
            "at the start of this bundle. Use to chain bundles past "
            "the 1000-frame cap while preserving character/lighting "
            "identity at the seam."),
io.Float.Input("prior_segment_strength", default=1.0, min=0.0, max=1.0,
    tooltip="Anchor strength. 1.0 forces frame 0 to match the prior "
            "tail exactly; lower values blend with prompt-driven "
            "content."),
```

And in `execute()`, after the existing guide_data build (after line ~556):

```python
if prior_segment_image is not None:
    resized = _resize_image(prior_segment_image, derived_w, derived_h,
                            resize_method, divisible_by)
    # Insert at index 0 so the prior tail anchors at frame 0.
    # If the timeline already has a segment at start=0, the user should
    # set its imageFile to None (or just not include it) and let the
    # prior_segment_image be the bundle's frame-0 anchor.
    guide_data["images"].insert(0, resized)
    guide_data["insert_frames"].insert(0, 0)
    guide_data["strengths"].insert(0, float(prior_segment_strength))
```

That's it. ~20 lines total including the schema additions. The new
guide entry rides through `LTXDirectorGuide.execute()`'s existing loop
(line 75-89) and `append_keyframe` accounts for it in the pre_filter
correctly. No model-side changes.

**Caller-side ergonomics** — extracting the prior tail is one ffmpeg
shell-out for the user (or in dhee, a `VHS_LoadVideo` →
`GetImageRangeFromBatch` chain in the workflow JSON). The workflow
graph just adds:

```
VHS_LoadVideo (prior.mp4)
  ↓
GetImageRangeFromBatch (start_index=-1, num_frames=1..8)
  ↓
LTXDirector.prior_segment_image
```

**Effort** for the PR:
- Code: ~20 lines in `ltx_director.py` (schema + execute body).
- Testing: build a chain example workflow, run a 2-bundle render.
- Tooltips + a short README section showing the chain pattern.
- Total: ~half a day for someone with the context from this guide.

**Risk**: low. Change is purely additive — optional inputs default to
None, existing workflows are unaffected. The maintainer
(`WhatDreamsCost`) is active (v1.3.9 in the changelog) and the use
case is broadly useful (chaining is a standard LTX 2.3 production
need, not dhee-specific), so likelihood of acceptance is good.

**Recommendation**: open an issue first on
https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI describing
the use case (chain bundles past 1000-frame cap, with the LTX model's
keyframe-mismatch error as evidence that the external-AddLatentGuide
approach is architecturally wrong). Propose the two-input addition.
Wait for maintainer signal on shape (they may prefer e.g. a separate
`LTXDirectorExtend` node, or a different input name).

If the issue gets a green light, send the PR. ~1-2 weeks turnaround if
maintainer is responsive.

**Fork vs upstream**: not worth forking for a 20-line change unless
the issue stalls. For dhee's launch, A2.5 (last-frame override) is the
immediate unblock; the PR is parallel work that lands when it lands.

### ACE-Step audio handoff (deferred)

The Director supports `audioSegments` with `audioFile` or `audioB64`
references plus `use_custom_audio: true`. The plan was to generate
dialogue audio with ACE-Step 1.5, save to a wav, feed it as a segment.
This eliminates LTX's audio guessing entirely — the audio is fixed and
LTX lip-syncs to it.

Schema (from `ltx_director.py`):

```ts
type AudioSegment = {
  audioFile?: string;      // path in ComfyUI input dir
  audioB64?: string;       // base64 inline alternative
  start: number;           // pixel-frame where audio begins
  trimStart?: number;      // frames to skip from source
  length?: number;         // frames to use
  fileName?: string;       // for log messages
};
```

Build out when we get back to the original plan.

## Performance numbers (Windows local box, RTX, 480p)

| Shots | Total frames | Wall time |
|---|---|---|
| 3 (14s) | 337 | 6m 28s |
| 3 (13s) | 313 | 5m 23s |
| 3 (13s, w/ tile decode, no preview) | 313 | 4m 15s |
| 3 (13s, w/ paraphrase fix + neg) | 313 | 4m 18s |
| 5 (24s, w/ tile decode) | 577 | 8m 8s |

Rough rule: ~50-65s per 100 pixel-frames at 832×480. Tile decode adds
~10-20s vs plain decode but doesn't crash; previewer removal saved
~30-60s and prevents OOM.

## Failure modes seen — and the fix

| Symptom | Root cause | Fix |
|---|---|---|
| `5161648128 bytes alloc fail` in `decode_latent_to_preview_image` | `LTX2SamplingPreviewOverride` upsamples full latent batch for preview | Remove node 79 + tiny VAE; chain LoRA directly off UNETLoader |
| Windows fatal exception in `causal_video_autoencoder.run_up` at end of sampling | Plain `VAEDecode` exceeds heap on long renders | Swap to `LTXVSpatioTemporalTiledVAEDecode` |
| Paraphrase speech + quoted line both spoken | LTX honors paraphrase as a generation prompt | `stripDialogueParaphrase()` — drop pronoun-led dialogue-verb sentences from description |
| Wrong-gender voice on visible character | Paraphrase + quoted line confuses speaker identity | Same fix as above — paraphrase strip resolved both |
| 502 Bad Gateway on image upload | ComfyUI process crashed (typically from one of the OOMs above) | Restart ComfyUI on Windows box |
| LTX Director / DirectorGuide nodes missing | WhatDreamsCost-ComfyUI plugin not installed on cloud Comfy | Use local; cloud has all other LTX core nodes but not the plugin |
| Total frames > 1000 | Hard cap on `LTXVEmptyLatentAudio.frames_number` | Chain bundles via A3 (latent-guide anchor), or pick a smaller shot range |

## How to add to this doc

When a new failure mode shows up:

1. **Reproduce twice** so we know it's not a one-off.
2. **Find the root cause** — read the actual stack trace, find the node
   class causing it, look in the plugin source if needed.
3. **Add a row** to "Failure modes seen — and the fix" with symptom,
   cause, fix.
4. If the fix changed prompt patterns, update the "Prompt structure"
   section.
5. If it changed the loader/decode topology, update the "Loader stack"
   table.
6. Bump the "Last updated" date at top.

When a new prompt pattern works better:

1. Note the *specific* improvement and what it replaced.
2. Add an example showing the old vs the new prompt.
3. If it's a heuristic that can be auto-applied (like `stripDialogueParaphrase`),
   reference the implementation file/function.
