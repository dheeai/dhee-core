# Winning prompt patterns (validated against Klein via zrok)

After 30+ Klein renders across LLM-generated and hand-crafted prompts on 5
test shots from Ruby V3, the diagnosis is conclusive: **Klein is a faithful
renderer at the prompt level it receives. The bug is upstream — bad prompts
from the LLM(s), not bad rendering from Klein.**

## What was tested vs what worked

| Variant | What changed | Klein orientation result on s2-shot-1 |
|---|---|---|
| Production (LLM-generated, current guide) | baseline | face-to-face / face-camera ✗ |
| LLM with v1 guide (soft "default to back-to-camera") | guide-only | face-to-face / face-camera ✗ |
| LLM with v2 guide (hard mandate + banned vocab list) | stronger guide | face-to-face / face-camera ✗ |
| LLM with v3 guide (mandate + worked example) | strongest guide | face-to-face / face-camera ✗ |
| Diagnostic: current guide, shotDescription rewritten | input fix only | back-to-camera ✓ |
| Hand-crafted prompt (no LLM, direct prose) | bypass LLM | back-to-camera ✓ |

The LLM (DeepSeek v4-flash) consistently trusts the `shotDescription`
prose over meta-rules in the system prompt. No guide-level escalation
fixes this. The fix lives upstream where `shotDescription` is written
(scene_breakdown stage) AND at the image-prompt stage where a few prose
rules separately improve identity / hallucination outcomes.

## Per-shot patterns that worked at Klein

All five shots passed with hand-crafted prompts (s4-shot-5 needed a v2
because v1 led with the Lambo and dropped Ruby; v2 leads with Ruby
through the windshield).

### scene-2-shot-1 — approach beat, back-to-camera

Body prose:
> "Ruby (red-haired, leather jacket) and Angel (Black man, dark hoodie)
> seen FROM BEHIND, their backs to camera in the foreground, walking up
> to the weathered pawn shop facade that rises ahead of them in the
> deep-focus background. … We see the back of Ruby's red hair … and the
> back of Angel's dark hood. The pawn shop's barred window, faded gold
> lettering, and dead pink neon 'O' visible AHEAD of them. … Mood:
> suspended tension — read entirely from the set of their shoulders and
> the stillness of their stance."

Why it worked:
- Explicit **"seen FROM BEHIND"** + **"their backs to camera"** — no escape hatch.
- Inline visual hook on EACH character at first mention.
- Destination explicitly **AHEAD** of the characters.
- Posture-only descriptors (back of hair, back of hood, set of shoulders).
- Zero face/eye/expression/gaze words.

### scene-2-shot-9 — OTS robbery, owner sharp, backs of robbers

Body prose:
> "Over-the-shoulders shot: Ruby (red-haired, leather jacket) and Angel
> (Black man, dark hoodie) both seen FROM BEHIND in the immediate
> foreground, their backs filling the lower left and lower right of the
> frame respectively, both blurred in soft focus. Between their
> silhouetted backs, the owner (balding white man, button-up shirt)
> stands razor-sharp in the midground behind the long wooden counter,
> his face pale with terror, both hands jerked upward … — the only sharp
> face in the frame."

Why it worked:
- Same "FROM BEHIND" mandate plus a position lock ("lower left and lower right").
- Multi-character inline hooks on all three characters including the owner.
- **"the only sharp face in the frame"** is a load-bearing line — it tells
  Klein the OTHER two characters do not have faces visible (because
  back-to-camera).
- Fixed the Ruby-as-Angel identity bleed seen in production.

### scene-4-shot-11 — close-up identity preservation

Body prose (minimal — 527 chars total):
> "Extreme close-up of Angel (Black man, clean-shaven, short coiled hair,
> dark hoodie) lying on his back on the sun-bleached asphalt, his face
> filling the frame, eyes open and looking directly up into the camera.
> A streak of blood traces from his right temple down to his jaw.
> High-angle, the camera looking straight down at his face. Razor-sharp
> focus on Angel's face. …"

Why it worked:
- MINIMAL prose — fewer competing signals for Klein to balance.
- Identity reinforced with explicit descriptors that match the reference
  image: "Black man, clean-shaven, short coiled hair, dark hoodie".
- Production's failure was a 685-char prompt with rasa cues, lighting
  detail, palette, atmosphere — Klein lost identity in the noise.
- The bearded-old-man hallucination in production is fully fixed.

### scene-4-shot-6 — wide impact shot

Body prose (434 chars):
> "Wide low-angle shot. The green Lamborghini has mounted the curb, its
> chrome front bumper pressed against the waist of Angel (Black man,
> dark hoodie, short coiled hair), whose body is folded forward over the
> hood. The small red crystal still clutched in his hand. …"

Why it worked:
- Limited Angel's pose to "folded forward over the hood" — close enough to
  the standing reference pose that Klein can transform without losing
  identity. v1's "spinning through the air" would have failed.
- Green Lambo described from text (no ref slot for it). Worked.

### scene-4-shot-5 — Ruby IN car (the tricky one)

v1 (FAILED — Ruby dropped from inside-car slot):
> "Medium side-angle shot under harsh midday sun. A sleek green
> Lamborghini fills the left half of the frame … Inside the driver's
> seat, Ruby (red-haired, leather jacket) grips the steering wheel …"

v2 (lead with Ruby — VALIDATED, 3/3 seeds rendered Ruby correctly inside the car):
> "Through the driver-side windshield of a green Lamborghini parked at
> the curb, Ruby (red-haired, leather jacket) is clearly visible seated
> in the driver's seat — both hands gripping the steering wheel, her red
> hair catching the harsh midday sun streaming through the glass …"

Lesson:
- For "person inside vehicle" shots, **lead with the person AS the focal
  subject**. If the prompt opens with the vehicle as subject, Klein
  treats the person as decoration and may drop the slot entirely.

## Pattern catalogue — the rules that ACTUALLY move Klein output

These are the load-bearing prose rules (validated empirically against
Klein, not theoretical):

### A. Inline visual hook on every character's first mention
- Format: `[Name] ([4-8 word distinguishing descriptor])`
- Examples:
  - `Ruby (red-haired, leather jacket)`
  - `Angel (Black man, dark hoodie, short coiled hair)`
  - `the owner (balding white man, button-up shirt)`
- This is the single most effective fix for the Ruby-as-Angel identity
  bleed bug. The existing guide tells the LLM to do this; the LLM
  intermittently skips. A deterministic post-pass that scans for
  unhooked first-mentions and injects the hook from the character
  profile would eliminate the bleed deterministically.

### B. Lead with the focal subject
- The first sentence's first noun is what Klein anchors on.
- If a character is INSIDE a vehicle and the vehicle is mentioned first,
  Klein may drop the character. Lead with the character.
- General rule: open with whatever should be sharpest in focus.

### C. Minimal prose for hero close-ups
- 400-600 char body for close-ups; 600-900 for medium/wide.
- Production's 685-char prompts with rasa/palette/atmosphere/lighting all
  packed in hurt identity because Klein had too many competing signals.
- The shot_image_prompt_guide currently says "80-220 words" (~500-1500
  chars) — the upper range is hurting identity. Tighten to 60-130 words
  for close-ups.

### D. For back-to-camera shots: hard rules
- Use the EXACT phrases: `"seen from behind"`, `"their backs to camera"`,
  `"the destination ahead of them"`.
- Describe what is visible from behind: `"back of [CHAR]'s hair / hood /
  head"`, `"set of [CHAR]'s shoulders"`.
- Name the destination explicitly so Klein knows where the characters
  are looking.
- ZERO mentions of: face, eyes, expression, gaze, look, glance, exchange,
  jaw, brow, lips, "in profile", "side angle of [CHAR]".

### E. Banned weasel words for slotted characters
- Never write: `"barely visible"`, `"a dark silhouette"`, `"blurred in
  the background"`, `"a smeared figure"` for a character who has a
  reference slot. Klein interprets this as "deprioritize this slot" and
  drops the character.
- If a character must be background atmosphere, drop their ref slot
  entirely and describe a generic figure in the prose. You lose identity
  binding but you don't lose the character.

### F. Don't ask for radical pose transformations from a reference
- The standing-portrait references can be transformed into "leaning",
  "seated", "folded over a hood" — small changes work.
- Cannot reliably transform into "spinning mid-air after impact",
  "sprawled on back at high angle close-up", "diving sideways".
  Identity drift kicks in.
- For genuine radical-pose shots, either (a) describe the character
  minimally and accept some hallucination, or (b) generate a
  pose-specific character ref upstream via the `derivedFrom` chain that
  already exists in `shotImagePipeline.ts:548-599`.

## Proposed two-tier fix

### Tier 1 — upstream at scene_breakdown (highest leverage)

Modify `prompts/skills/defaults/scene_breakdown_shot_guide.md` so the
LLM that writes `shotDescription` for an approach beat never emits face
cues. Trigger: `purpose ∈ {meet_character, set_arrival, enter_location,
depart_location, pursue, flee, follow_into}`.

For these beats, the `description` field must follow templates like:
- `"[CHAR_A] and [CHAR_B] approach the [destination] from the [origin],
  walking toward the [entrance/landmark]."`
- `"[CHAR_X] walks into the [location] from the [origin], heading toward
  the [destination] visible at the end of the [room/street]."`

NEVER:
- `"exchange a look"`, `"locked gazes"`, `"face set with"`, `"determined
  expression"`, `"eyes meet"`.

This is the highest-leverage fix because once `shotDescription` is
clean, the existing image-prompt guide produces good back-to-camera
prose with no changes (we proved this in the diagnostic).

### Tier 2 — at the image-prompt layer (incremental wins)

Modify `prompts/skills/defaults/shot_image_prompt_guide.md` to:

1. Add the **back_to_camera framing row** + the BACK-TO-CAMERA MANDATE
   section from `proposed_v3_guide.md`. Even though it didn't help alone
   when fighting bad descriptions, it WILL help once Tier 1 fixes the
   descriptions — at that point the guide just needs to give the LLM
   the right vocabulary.
2. Add the **"lead with the focal subject"** rule with the worked example
   from scene-4-shot-5 v1 vs v2.
3. Add the **"banned weasel words for slotted characters"** rule
   (banned: barely visible, silhouette, blurred).
4. **Tighten word count** for close-ups: change "80-220 words" to
   "60-130 words for close-ups, 100-180 for medium/wide".

### Tier 3 — deterministic post-pass (cheapest defensive net)

Add a small post-pass to `shotImagePipeline.ts` that runs on every
generated image prompt:

1. Scan `references[]` for character refs. For each, find the first
   mention in the prose. If it lacks a parenthetical visual hook, inject
   one from the character profile. Solves identity bleed deterministically.
2. If `purpose` is an approach beat AND the prose contains banned face
   words ("exchange a look", "eyes meet", etc.), log a warning and
   optionally regenerate. Forces the upstream contract.

## Test harness location for future regression

- `scripts/orientation-ab/handCraftedPrompts.ts` — the validated
  hand-crafted prompts. Re-run after any guide change to confirm the
  Klein output still matches.
- `scripts/orientation-ab/results/renders/*_hand_v1.png` — golden images
  for each shot. Visual diff against these after each iteration.
- Reproduce with: `COMFYUI_BASE_URL=https://comfyui.share.zrok.io
  COMFY_MODE=local npx tsx scripts/orientation-ab/renderPrompts.ts
  --condition hand_v1`
