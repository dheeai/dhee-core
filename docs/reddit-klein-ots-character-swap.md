# FLUX 2 Klein swaps character roles in OTS shots — anyone seen this?

Pulling my hair out on this one. Hoping someone here has run into it or knows the actual mechanism.

## What I'm doing

Generating anime-style frames for a video project on ComfyUI Cloud using FLUX 2 Klein Edit. Each shot has a setting image as the base + 1–3 character reference images. Klein composes them with my prose prompt and I get back the framed shot.

The two characters in question are mother and daughter from this scene:

- **Parvati** — 35yo woman, green kurta/salwar, hair in a bun, canvas bag over shoulder, weathered face. *(ref image attached)*
- **Isha** — 16yo athletic girl, red crop top, black shorts, high ponytail, gym bag, neon sneakers. *(ref image attached)*

## The problem

Over-the-shoulder framing with both characters in frame: Klein consistently puts the *wrong* character in focus.

My prompt wants Parvati blurred in the foreground (the OTS anchor) with Isha sharp in the background as the focal subject. Klein does the exact opposite — Isha goes blurred up close, Parvati ends up in razor-sharp focus at the gate. Every. Single. Time.

Here's the actual prompt I'm using:

```
Over-the-shoulder of Parvati from image 2, her shoulder and back of head softly blurred in
the near foreground, leading the eye to Isha from image 3 in razor-sharp focus. Isha stands
at the rustic gate of the district sports complex from image 1, her body beginning to rotate
left, weight shifting to her right foot, left foot lifting slightly off the ground, head
angled downward with a dismissive expression, mouth slightly open as if saying 'I know.'
Parvati's coaching hand gestures are visible at the edge of frame but blurred. The gate is
bathed in golden dawn haze with swirling dust motes, neem trees silhouetted in the background.
Warm golden light from the right casts soft shadows on Isha's face and the ground. Mood:
impatience giving way to action, a moment of dismissal before movement., anime style, anime
art, vibrant colors, detailed anime, studio quality anime, anime aesthetic
```

Reference images uploaded in this order (Klein has 4 LoadImage slots: 1 base + 3 refs):

- `base_image` — setting reference (district sports complex)
- `reference_image_1` — Parvati
- `reference_image_2` — Isha
- `reference_image_3` — (filled with the base image; Klein refuses to run with an empty slot)

## Sanity check — same prompt, six different seeds

I figured maybe Klein's output is just stochastic, certain seeds happen to land correct. So I tested with seeds `[13, 2027, 441, 98765, 1234567, 88888]`.

**All six swapped.** Foreground figure is Isha (red crop top, ponytail), focal at the gate is Parvati (green kurta, bun). Six for six.

*(grid of 6 images attached)*

So this isn't stochastic. There's something in the prompt or the refs that's consistently pushing Klein to assign roles backwards.

## What I tried in prose

### Variant A — prepend a visual descriptor before the name

Idea: maybe Klein needs more visual cues to disambiguate similar-looking refs.

```
... Over-the-shoulder of a 35-year-old woman with sturdy weathered frame, Parvati from image 2,
... leading the eye to a 16-year-old athletic prodigy with tall lean runner's physique, Isha
from image 3 in razor-sharp focus...
```

Result: **feature blending** across the two refs. Foreground figure gets Isha's red top + ponytail BUT Parvati's hair styling. Focal figure gets Parvati's green kurta on Isha's face shape. Worse than baseline — at least baseline kept characters cleanly distinct, just with swapped roles.

### Variant B — descriptors only, no proper name

Same idea but replacing the name entirely:

```
... a 35-year-old woman with weathered frame from image 2 ... a 16-year-old athletic prodigy
from image 3 in razor-sharp focus...
```

Result: even more blended. Klein loses the name anchor and the partition between refs collapses harder.

### Variant C — restructure to put the focal character first, drop "OTS of X" entirely

Rewrote the prose so the focal character is introduced first and the anchor is described as a compositional blur:

```
Isha from image 3 in razor-sharp focus, standing at the rustic gate ... In the near foreground
of the composition, Parvati from image 2's shoulder and back of head appear as a softly
blurred silhouette, her coaching hand gestures blurred at the edge of frame...
```

Result: 6/6 blended at the same six seeds. The expanded prose with both characters described in detail seems to break Klein's cross-attention partition altogether — features bleed across both refs even more aggressively than Variant A.

### Variant D — append an explicit contrast clause

```
... Over-the-shoulder of [descriptor], Parvati from image 2 (distinctly not [other character's
descriptor]) ... Isha from image 3 in razor-sharp focus (distinctly not [Parvati's descriptor])...
```

Result: 1/6 correct, 3/6 swapped, 2/6 blended. Marginal at best.

## What I think is happening (but can't prove)

My working hypothesis: in Klein's training-caption distribution, "OTS of X" probably more often meant "X is the character visible past a shoulder" — i.e., X is the *focal* character — which is the opposite of how cinematographers use the phrase. So when Klein reads "Over-the-shoulder of Parvati", it commits Parvati to the focal slot before it ever processes the rest of the prompt. By the time "Isha in razor-sharp focus" arrives, the role's already taken and the language gets glommed onto Parvati anyway.

Then for the elaborated prose variants: every extra adjective about a character widens that character's attention footprint across all the ref images, and with similar-looking refs that footprint overlaps. Result: feature blending instead of clean role swap.

## A working case from the same project

Same overall project, different shot — Parvati + Mrs. Singh (a totally different character: older, white sari, indoor dining scene). Same prose pattern, same OTS framing. **Renders perfectly.** Klein puts Mrs. Singh in focus and Parvati blurred in the foreground exactly as written.

So Klein *can* do OTS correctly. Just not when the two characters look similar enough — mother and daughter, both tan-skinned, both black-haired, similar face shapes.

## A different model — composition correct, style wrong

Sent the same prompt + refs through `grok-imagine-image-beta` on the same cloud. Composition was correct (Isha focal, Parvati blurred). But it rendered in a semi-realistic painterly style instead of the cel-shaded anime style my refs use. Style consistency matters as much as role correctness for my use case (this is one frame of a multi-shot video; can't have one frame render in a different style), so Grok isn't a fix.

## My ask

What's the actual mechanism here? Is there a known way to push Klein's role assignment around when refs look similar, without triggering the blending failure mode?

Things I haven't tried yet:

- Strong negative prompt targeting the wrong assignment (`"Parvati in focus, Isha blurred"` as negative)
- Pulling the OTS anchor through a ControlNet for compositional placement
- Reordering ref slots — does putting the focal character at `reference_image_1` vs `reference_image_2` change anything? Haven't tested rigorously
- Different sampler / step counts (currently 4-step distilled)
- Some kind of attention mask config I'm not aware of

If anyone has hit this with mother/daughter or sibling-style pairs in OTS comps, would love to hear what actually worked. I can share the workflow JSON, the refs, all the outputs if it helps debug.

**Reproduction:**

- ComfyUI Cloud (cloud.comfy.org)
- Model: `ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors` *(actually that's the LTX one — for Klein I'm on the FLUX 2 Klein Edit Cloud workflow with the distilled FLUX checkpoint. Updating this in a comment.)*
- Workflow: 4-step Klein Edit, distilled
- Output: 1024×576

Cheers.

---

### Image attachments (in order)

1. `ref_parvati.png` — Parvati character reference
2. `ref_isha.png` — Isha character reference
3. `ref_setting_image.png` — district sports complex setting (base image)
4. `s1shot6_v0_baseline_seed13.png` — Klein output, baseline prompt, seed 13 (swapped)
5. `s1shot6_v0_baseline_seed2027.png` — seed 2027 (swapped)
6. `s1shot6_v0_baseline_seed441.png` — seed 441 (swapped)
7. `s1shot6_v0_baseline_seed98765.png` — seed 98765 (swapped)
8. `s1shot6_v0_baseline_seed1234567.png` — seed 1234567 (swapped)
9. `s1shot6_v0_baseline_seed88888.png` — seed 88888 (swapped)
10. `s1shot6_v1_prepend_desc_seed*.png` — Variant A (blending example)
11. `s1shot6_v3_contrast_seed1234567.png` — Variant D, the only one that landed correct (1/6)
12. `s1shot6_v4_focal_first_seed*.png` — Variant C (full blending)
13. `s3shot3_first_frame_klein_*.png` — the working case, Parvati + Mrs. Singh
14. `s1shot6_grok_ots_seed13.png` — Grok output (correct composition, wrong style)

Source files all live under `sun_hadnt_yet_cleared-2.dhee/assets/images/probe_klein_seed_variance/s1shot6/` and `assets/images/probe_grok_ots/`. Upload to imgur or similar before posting.
