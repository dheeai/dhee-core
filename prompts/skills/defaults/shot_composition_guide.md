**PURPOSE**: Write one image prompt paragraph for a specific shot within a multi-shot scene. The prompt will be fed directly to an image generation model.

---

## RENDER STYLE ANCHOR — HARD CONSTRAINT (highest priority)

The user message contains a `<render_style_anchor>` block carrying the project's Visual style (e.g. `anime`, `cinematic_realism`, `3d_animation`). That block dictates:

1. **The EXACT clause your positive prompt MUST OPEN with**, pasted verbatim. Example for `anime`:
   `"Hand-drawn anime cel, flat color planes, crisp ink line work, painted background, cel-edge rim light, anime hair highlights — "`
   Then continue your prose immediately after the trailing `— ` separator.

2. **MANDATORY tokens to include in the negative prompt**, in addition to your own avoid-list.

**Why this is non-negotiable**: Flux Klein and Z-Image weight the prompt's *leading tokens* heavily. A style-neutral opener like *"A wide overhead establishing shot of Tokyo's night skyline, deep focus…"* produces a photorealistic Tokyo skyline even when the world-style bible elsewhere says "cel-shaded edges". The anchor forces the model to commit to the project's rendering aesthetic from the first token of the prompt.

**If the user message has NO `<render_style_anchor>` block**: fall through to the general world-style guidance. (The block is omitted when `project.style` is unset.)

Do not paraphrase the anchor clause. Do not "merge" it into your shot description. Paste it verbatim, then continue.

---

## Step Zero: Extract These Six Facts From the Motion JSON

Before writing a single word of the prompt, extract and write down:

1. **The referenceImages list for THIS shot** — the exact image numbers listed (e.g., image 1, image 2). These are the ONLY images you may reference. Image numbers not in this list DO NOT EXIST for this shot.
2. **The characters present in THIS shot** — only characters named here appear in the prompt.
3. **The peak visual event** — what is the single most dramatic, specific thing happening RIGHT NOW in this shot? Not before, not after. Not "ships arrive" if the shot shows beams firing. Not "character reacts" if the shot shows their face dissolving into shock at a specific cause.
4. **The shot type** — determines framing, depth of field, and what fills the frame.
5. **The perspective** — whose POV is this shot from? `main_subject`, `secondary_subject`, `observer`, `overhead`, or `god`. This controls the camera position relative to the characters (see Perspective → Framing Bias table below).
6. **The focus** — `focus.primary` is what's razor-sharp; `focus.background` lists visible-but-blurred elements; `focus.lurking` is a defocused element planted for later. Your prose MUST name what is sharp and what is blurred.

---

## Reference Image Rule — Hard Constraint

**You may only reference images explicitly listed as available for THIS specific shot.**

- Reference each available image using "from image N" phrasing (e.g., "the character from image 1", "the environment from image 2", "the hover-car from image 3").
- Reference images can be characters, settings, or **objects/props** (vehicles, weapons, artifacts, distinctive items).
- Every image in the shot's referenceImages list MUST appear somewhere in the prompt paragraph.
- If image 3 is not in this shot's referenceImages list, you CANNOT write "from image 3". Not even if you saw that image referenced elsewhere. Not even if the setting seems to match.
- **If a character is NOT described as visible in the shot description, do NOT reference their image — even if it's in the available list.** Available references are for the whole scene; only use the ones relevant to THIS shot.
- If no characters or settings from the available list appear in the shot, use `text_to_image` mode with no "from imageN" references and an empty references array.

**Fabricating image numbers is a critical error. If you write "from image 4" and image 4 is not in this shot's list, the prompt is wrong.**

---

## Shot Composition Rules

The shot type from the motion JSON determines framing, camera position, and depth of field. State these explicitly in the prompt paragraph.

| Shot Type | Composition | Depth of Field |
|-----------|-------------|----------------|
| **extreme_wide** | Vast environment, character tiny or absent, establishes scale | Deep focus — full environment sharp |
| **wide / establishing** | Full environment with characters head-to-toe | Deep focus — foreground and background both sharp |
| **medium_wide** | Character from knees up, some environment visible | Moderate — subject sharp, background slightly soft |
| **medium** | Waist-up of character(s), conversational distance | Moderate shallow — subject sharp, background softly blurred |
| **medium_close_up** | Chest and head, captures expression and gesture | Shallow — subject sharp, background blurred |
| **close_up** | Face fills the frame — face is the primary subject | Shallow — face razor-sharp, background strongly blurred |
| **extreme_close_up** | Single feature (eyes, hands, object) fills frame | Very shallow — only the feature in focus |
| **low_angle** | Camera looking up at subject — appears powerful, dominant | Varies |
| **high_angle** | Camera looking down at subject — appears smaller, vulnerable | Varies |
| **dutch_angle** | Tilted frame, creates unease and tension | Varies |
| **birds_eye** | Directly above, unusual perspective, abstract feel | Deep focus |
| **reaction** | Character responding — focus on facial expression and body language | Shallow — face sharp |
| **over_the_shoulder** | From behind one character looking at another; foreground character blurred. **REQUIRES 2+ characters in frame.** | Shallow — far character sharp, near character blurred |
| **two_shot** | Two characters in frame together, showing spatial relationship | Moderate |
| **pov** | What a character sees, subjective perspective | Varies by what they're seeing |
| **insert** | Detail shot of object or action (hands, letter, clock) | Very shallow |
| **cutaway** | Brief shot of related element outside the main action | Varies |
| **tracking** | Camera follows moving subject, dynamic composition | Moderate shallow |

Rules:
- A wide or establishing shot uses deep focus and is dominated by the ENVIRONMENT. Characters in wide shots are small figures within the landscape, not central subjects. Do not write wide-shot prompts that center a named character's actions.
- A close-up means the face fills the frame. Do not describe the character standing in a vast environment.
- State depth of field explicitly in the prose every time.
- **Never use `over_the_shoulder` framing or the phrase `"over-the-shoulder of X"` when the shot has only ONE character ref.** OTS is inherently a two-character composition: foreground anchor (blurred) and focal subject (sharp). With only one character ref, the image model will either invent a phantom second character or distort the scene. For tight intimate framings of a single character (camera angled over the character's own shoulder, focusing on their hands or an object), use `insert`, `extreme_close_up`, or `close_up` shot types instead — and write the prose with the focal element (hands, object, face detail) as the subject. Example: instead of `"OTS view of Parvati from image 2 reaching for the bucket"`, write `"Insert shot: Parvati from image 2's hand reaching toward the bucket, fingers extended, in shallow focus..."`
- If the motion JSON specifies a camera angle (low angle, dutch tilt, high angle), include it in the prose.

---

## Perspective → Framing Bias

The shot's `perspective` field determines CAMERA POSITION relative to the characters. Use this table to inform your framing and prose.

| Perspective | Preferred shot types | Prose requirement |
|---|---|---|
| `main_subject` + POV | `pov` | First-person viewpoint; do NOT show the POV holder's face. Write "we see what Vikram sees — Laila gliding toward the table..." |
| `main_subject` + OTS | `over_the_shoulder` (**ONLY if 2+ characters in frame**) | Back of the subject's head/shoulder blurred in foreground; camera peers over their shoulder. "Over Vikram's shoulder — Laila approaches, his soaked kurta softly blurred in the near foreground." If only ONE character is in the shot, IGNORE this row — use `insert` / `extreme_close_up` / `close_up` and the rule below. |
| `secondary_subject` | `over_the_shoulder` (**ONLY if 2+ characters in frame**), `pov` | Frame from the secondary's viewpoint. Used for reaction reversals. |
| `observer` | `wide`, `medium`, `two_shot` | Neutral — neither character's side. "A wide view of the dhaba interior: Vikram at the table on the left, Laila stepping in from the right." |
| `overhead` | `birds_eye`, `high_angle` | Camera clearly above the subject looking down. "High angle from above, looking down on the table..." |
| `god` | `extreme_wide`, `birds_eye` | Impossible omniscient viewpoint. Often an extreme wide or top-down cosmic view. |

**Rules:**
- The perspective OVERRIDES or REFINES the cameraWork's framing. If cameraWork says "medium shot" and perspective is `main_subject` (POV), prefer the POV treatment.
- If `perspectiveOf` is set, use that character as the POV/OTS anchor.
- Never describe the POV character's face in a POV shot — they're looking out of the frame, not into it.
- **The single-character OTS rule beats this table.** If the shot has only ONE character ref, NEVER write `over-the-shoulder` or `OTS` into the prose — even when `cameraWork` upstream said OTS, even when `perspective` is `main_subject` or `secondary_subject`. Override the cameraWork: pick `insert` / `extreme_close_up` / `close_up` and write the focal element (the hand, the object, the face detail) as the subject. A validator at output time will reject any frame that violates this and force you to regenerate.

---

## Focus Rules — Sharp vs Blurred

The `focus` object from the shot JSON tells you EXACTLY what should be in focus and what should be blurred.

- **`focus.primary`**: name this element in the prose as razor-sharp with explicit DOF. Example: "Laila's face razor-sharp in a shallow depth of field."
- **`focus.background`** elements: name them in the prose as "visible but blurred" or "soft bokeh in the background" or "out-of-focus behind the subject."
- **`focus.lurking`** element (if set): describe it as "barely registered in the defocused background, partially obscured" — present but not drawing the viewer's eye.

**Worked example:**
- `focus.primary = "laila_face"`, `focus.background = ["vikram_shoulder", "torches"]`, `focus.lurking = "cloaked_figure"`
- Prose: "A medium close-up over Vikram's shoulder, Laila from image 2 in razor-sharp focus, kohl-rimmed eyes fierce. Vikram's soaked kurta shoulder soft and blurred in the near foreground. Torch flames rendered as warm bokeh behind her. Barely visible at the rear of the dhaba, the cloaked figure from image 3 sits as a defocused indistinct silhouette — present in the frame but outside the viewer's attention."

**Rules:**
- Every prose paragraph for a shot with `focus` must explicitly name what is sharp AND what is blurred.
- Never contradict the focus — if `focus.primary` is a character, don't describe the environment as the visual center.
- If a `lurking` element is specified, it MUST appear in the prose as a defocused background element.

---

## Story Faithfulness Rules — Read the Scene Literally

The scene description and the motion JSON for this specific shot are the only source of truth. Copy details from the text. Do not interpret, embellish, or fill gaps with assumptions.

**The failure mode is inventing details that aren't there.** Examples of what NOT to do:
- The scene says "perfectly normal Manhattan morning" → do NOT write "gray afternoon sky"
- The scene says "civilians dissolve into golden particles" → do NOT write "golden particles swirl around the ships" — the particles come FROM people, not from ships
- The scene says "silver-white beams fire down" → do NOT describe only ships arriving and omit the beams

**Before writing, answer these questions from the source material only:**
- What is the single peak action or event in THIS shot? (Not the whole scene — this shot specifically.)
- Who is physically present and what are they doing at this exact moment?
- What is the time of day, weather, and environment described for THIS shot?
- What causes the reaction or event? Name it specifically.

Then write only what those answers contain.

- If the scene says golden particles: write golden particles — not "panic" or "fear."
- If the scene says daytime: use daytime — do not introduce rain, night, or storm.
- If a character is reaching out: show them reaching — do not show arms crossed.
- If something is transforming, dissolving, erupting, or colliding — that transformation IS the shot. Depict it directly and specifically.
- If someone is reacting — to what? Name the cause explicitly. "Her face frozen in horror as silver-white beams lance down into the crowd below" is correct. "Her face frozen in horror" is incomplete.

Only include locations, characters, objects, and atmosphere described in this scene and this specific shot. Do not import elements from other shots.

**Time-of-day and lighting must match the scene description exactly.** If the scene says "moonlight" or "night", do NOT write "sunlight", "daylight", or "golden hour." If the scene says "morning", do NOT write "night" or "dusk."

If a character appears in this shot but needs an appearance change from their reference image (different clothing, injuries, different emotional state), describe those changes explicitly.

**Characters and shot description must match exactly.** If the shot description says no characters are visible (establishing shot, insert shot, atmosphere shot), do NOT add characters to the image prompt — even if character reference images are available. Only reference character images for characters explicitly described as visible in THIS shot.

---

## Lighting Rules — All Four Components Required

Lighting must appear inside the prompt paragraph. You must include all four:

1. **Source**: natural sunlight, overcast sky, practical lamp, alien energy glow, streetlights, fire
2. **Direction**: overhead, camera-left, from behind (rim), from below
3. **Quality**: harsh/hard (sharp shadows), soft/diffused (gentle gradients), dappled
4. **Temperature**: warm golden, cool blue, neutral white, sickly green

Do not write "dramatic lighting" or "cinematic lighting" — name the actual source, its direction, its quality, and its color temperature.

If the scene describes a specific light source (energy beams, alien glow, emergency lights), that source must appear in the lighting description with all four components.

Match lighting to what the scene describes. Do not add atmospheric elements (storm, fog, night) the scene does not include.

---

## Frozen Instant — No Motion Verbs

An image prompt describes a SINGLE FROZEN FRAME — one instant in time. The camera has captured this moment and nothing is moving.

**Banned motion verbs:** running, walking, crawling, reaching, turning, falling, moving, stepping, rising, shifting, flying, spinning, drifting, floating, sliding, swinging, lunging, leaping, charging, retreating

**Use static equivalents instead:**
- "running" → "mid-stride, left foot forward, right arm back"
- "crawling" → "on hands and knees, weight on left hand, right hand extended forward"
- "reaching" → "arm outstretched toward the basket, fingers splayed"
- "turning" → "head angled forty-five degrees to the left, eyes directed at the door"
- "falling" → "suspended mid-air, hair fanned upward, coat billowing"

Every verb in the prompt must describe a STATE, not an ACTION. Ask: "Could a photographer capture exactly this in a single frame?" If not, rewrite it.

---

## Prompt Construction

Write a single flowing prose paragraph. Do not use bullet points, numbered steps, or keyword lists.

The paragraph must contain, in order:
1. The peak visual event and main subject — the specific action at its most dramatic moment
2. The setting and spatial relationships
3. Shot framing, camera angle, and depth of field (explicit words from the shot type table)
4. "from image N" references for every available image
5. Lighting with source, direction, quality, and temperature — all four
6. Mood or atmosphere

Lead with what is most dramatic and specific. Do not open with the environment when the event is the point.

Example structure: "A wide establishing shot of [environment from image 2], deep focus with foreground and background both sharp, showing [characters from image 1] [specific action at its peak]. [Lighting with all four components]. [Mood]."

---

**Output format:**
```
**Image Prompt:**
[Single detailed paragraph matching the shot's framing. Reference characters/settings with "from imageN" phrasing only for images explicitly listed as available for this shot. Lead with subject and action, then setting, then lighting, then mood. Write flowing prose — not comma-separated keywords.]

**Reference Images:**
- Character: [name] (only if in this shot and listed as available)
- Setting: [name] (only if in this shot and listed as available)

**Negative Prompt:**
[Style-appropriate negatives + inconsistent appearance, wrong features. Never negate elements that the scene description requires.]

**Aspect Ratio:**
1:1

**Generation Mode:**
image_text_to_image
```

If NO reference images are available (documentary/non-narrative), use `text_to_image` mode with no "from imageN" references.

---

## Choosing generationStrategy

You must include a `generationStrategy` field in your output JSON. This determines how many keyframe images are generated for video interpolation.

- **`flfv`** (first + last frame) — **DEFAULT for most shots.** Simple motion, character actions, camera moves, dialogue shots. The video model interpolates between start and end frames.
- **`fmlfv`** (first + mid + last frame) — Use for **complex transformations** where the mid-point state is important: disintegration effects, morphing, object reveals, major scene changes, physical transformations, magical effects, or any shot where the halfway point looks very different from a simple blend of start and end.

**Rules:**
- Default to `flfv` unless the shot clearly requires a mid-frame anchor
- If a shot involves VFX, magical effects, physical transformation, or any action where the intermediate state matters, use `fmlfv`
- When using `fmlfv`, include a `mid_frame` in the `frames` object

---

{{FRAME_GENERATION_GUIDE}}

---

## Multi-Frame Output (FLFV/FMLFV shots only)

When the shot's `videoGenerationMode` is `flfv` or `fmlfv`, you must generate MULTIPLE frame prompts in a single JSON object using a `frames` field.

### JSON Structure for Multi-Frame Shots

**FLFV example (first + last frame):**
```json
{
  "shotNumber": 2,
  "frames": {
    "first_frame": {
      "imagePrompt": "Full scene description for the opening frame...",
      "generationMode": "image_text_to_image",
      "references": [
        { "imageNumber": 1, "type": "character", "refId": "investigator" },
        { "imageNumber": 2, "type": "setting", "refId": "pataliputra_alleys" }
      ]
    },
    "last_frame": {
      "imagePrompt": "The investigator is now at the far end of the passage, barely visible in deep shadow, only the glint of torchlight on wet stone marking the path behind. The torch has burned low, casting the walls in deep amber.",
      "generationMode": "edit_first_frame",
      "references": []
    }
  },
  "negativePrompt": "...",
  "aspectRatio": "16:9"
}
```

**FMLFV example (first + mid + last frame):**
```json
{
  "shotNumber": 4,
  "frames": {
    "first_frame": {
      "imagePrompt": "Full scene description for the opening frame...",
      "generationMode": "image_text_to_image",
      "references": [
        { "imageNumber": 1, "type": "character", "refId": "kai" },
        { "imageNumber": 2, "type": "setting", "refId": "alley" }
      ]
    },
    "mid_frame": {
      "imagePrompt": "Description of mid-point — character now halfway across the space, expression shifted...",
      "generationMode": "edit_first_frame",
      "references": []
    },
    "last_frame": {
      "imagePrompt": "Description of end state — character reached the far side, lighting changed...",
      "generationMode": "edit_first_frame",
      "references": []
    }
  },
  "negativePrompt": "...",
  "aspectRatio": "16:9"
}
```

### Frame Generation Modes — Choose Per Frame

- **`image_text_to_image`** — Generate using character/setting reference images. Use for first frames that show **recognizable characters or settings at normal framing** (wide, medium, close-up showing a person or place).

- **`text_to_image`** — Generate from text description ONLY, no reference images. Use when:
  - The shot is an **extreme close-up on a detail** (dust particles, hands, objects, textures) where a setting reference would pull in the full room/scene instead of the detail
  - The shot shows **only abstract visuals** (light rays, shadows, water ripples) with no recognizable character or setting
  - The shot is a **cutaway/insert** focusing on a small object or body part
  - **Rule of thumb:** if the reference image would dominate the composition and override the close-up framing, use `text_to_image` instead

- **`edit_first_frame`** (for last_frame/mid_frame) — Generate by **editing the first frame image**. The image prompt should describe ONLY what changed, not the full scene. Use when the end state is **visibly different** from the start:
  - Character moved to a clearly different position in frame
  - A new object appeared or an existing one disappeared
  - Lighting changed dramatically (day→night, lamp turned on/off)
  - A transformation or VFX effect occurred

  **Last frame describes the END STATE** — what the shot looks like at the END of the duration. The video model interpolates between first and last frame. If they're too similar, there's nothing to animate.

  **The last frame must be DRAMATICALLY different from the first frame.** Think: "What does a camera capture 3-5 seconds LATER?" In 5 seconds, a lot changes:
  - A running character is now 20 feet further away, possibly at the edge of frame or gone
  - A turning head is now fully facing the other direction
  - An explosion that started has now engulfed the scene
  - A falling object has hit the ground with debris scattered

  **Use the `<last_frame_changes>` block** — it lists what the state tracking says must differ. But go FURTHER than the state changes. Ask: "After this shot's full duration, what would a freeze-frame look like?"

  **Good last frame examples:**
  - First: "Girl mid-stride, center frame" → Last: "Girl at far right edge of frame, receding into smoke, debris where a phantom collapsed behind her"
  - First: "Close-up of face, eyes wide with terror" → Last: "Same angle but expression shifted to bitter resolve, mouth open mid-shout, tears streaking through soot"
  - First: "Wide shot of empty burning street" → Last: "Same street but a massive chunk of building has crashed into the foreground, dust cloud filling the lower third"

  **Bad last frames (too similar):**
  - "The girl is now standing slightly to the left" — too minor, nothing to animate
  - "Same scene but with a slightly different expression" — image editor can't render subtle expression changes
  - Repeating the first frame with minor word changes

  Only write "No visible change from first frame." for pure static atmosphere shots (rain falling, fire burning) where the camera and subject don't move.

- **`edit_previous_shot`** (RECOMMENDED for first_frame of continuation shots) — Generate by **editing the previous shot's last frame**. This maintains visual continuity between consecutive shots in the same scene. The image prompt should describe ONLY what changed from the previous shot's end state. Use when:
  - The camera angle is similar or slightly shifted from the previous shot
  - The scene and characters are the same (continuation of action)
  - You want smooth visual flow between shots (same lighting, colors, composition)
  - Do NOT use for: establishing shots of new locations, dramatic camera angle changes, or the first shot of a scene

- **`text_to_image`** — Generate from text only, no references. Use for frames with NO characters visible (e.g., empty room, landscape).

### Rules

1. **first_frame of shot 1** (first shot in scene) ALWAYS uses `image_text_to_image` with full character/setting references
2. **first_frame of shot 2+** (continuation shots) PREFER `edit_previous_shot` for visual continuity — unless the camera angle or location changes dramatically
3. **last_frame** and **mid_frame** PREFER `edit_first_frame` — it keeps visual consistency within the shot
4. Only use `image_text_to_image` for continuation shots if the camera angle changed dramatically or it's a new location
5. The `edit_first_frame` and `edit_previous_shot` prompts should describe the DELTA (what changed), not the full scene
6. For `edit_first_frame` and `edit_previous_shot`, ALWAYS include character references using "from image N" phrasing and populate the `references` array — this is required for character consistency even when editing a base image. Reference every character visible in the shot
7. **refId MUST exactly match the available reference IDs** — copy them from the available references list. Do NOT invent or guess refIds. If the character is "mr_patel", write `"character_image:mr_patel"`, NOT `"character_image:mr_pattern"` or any variation
8. The last_frame should ALWAYS describe the end state. Check `<last_frame_changes>` for what must differ from first_frame

### Single-Frame Shots (i2v, t2v)

For `i2v` and `t2v` shots, do NOT use the `frames` field. Use the standard flat format:

```json
{
  "imagePrompt": "...",
  "negativePrompt": "...",
  "aspectRatio": "16:9",
  "generationMode": "image_text_to_image",
  "references": [...]
}
```