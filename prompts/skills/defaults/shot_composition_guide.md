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

## CONTRACT — Essence vs Composition (read first)

**The shot brief gives you the ESSENCE. THIS guide is AUTHORITATIVE for COMPOSITION.**

The upstream `<this_shot>` / `<scene_plan>` blocks tell you:
- WHO is in the shot (which characters, which setting, which objects)
- WHAT narrative beat is happening (the purpose: meet, react, transition, action, etc.)
- WHAT cinematic parameters are declared (cameraWork framing, perspective, focus)

The shot brief does **NOT** dictate HOW to compose the frame — orientation, character poses, gaze direction, what's visible from camera. The brief's prose often reads like a narrative summary ("they exchange a final look"), but **that prose is a story beat description, not a composition instruction.** Story beats can be expressed cinematically in many ways — face-to-face, back-to-camera, OTS, over a hand on a doorknob. Composition is YOUR job.

**Rule of thumb:** before writing the prompt, REPHRASE the brief's `description` into a one-sentence WHO+WHAT essence with all framing language stripped. Example:

> Brief description: *"Ruby and Angel stand before the weathered pawn shop facade under the harsh midday sun. They exchange a final look of shared determination, heat shimmer distorting the air around them."*
>
> Essence (your internal rewrite): *"Ruby and Angel, at the pawn shop entrance, sharing a beat of resolve before going in."*

Now compose THAT essence using the framing rules in this guide. For an approach beat (`purpose: meet_character`, characters arriving at a destination), the rules say back-to-camera. The original phrase "exchange a final look" is a STORY BEAT, not a camera angle — translate the beat into back-from-camera posture (shoulders squared, weight forward, the silence before motion). Do NOT echo "exchange a final look" into your prompt; that phrase will lock the image model into face-to-face profiles.

**This contract applies even when the brief uses face-cue language for an approach beat.** Treat the brief's wording as STORY, not as a camera instruction. The framing rules below override the brief's prose every time.

### Pose translation — same essence/composition split

The brief's description of physical action is also STORY, not pose instruction. Examples:
- Brief: *"his body is launched backward, spinning through the air"* → Essence: *"Angel is mid-impact, body folding over the car"* → Composition: limit the pose to one captured by a single freeze-frame the image model can render. For a slotted character (with a reference photo of them standing), prefer poses CLOSE to standing — "torso folded forward over the hood, knees bent against the bumper" beats "arms flung wide, feet leaving the ground" (the latter loses Angel's identity because the model can't transform a standing reference into a fully airborne pose at 4 sampling steps).
- Brief: *"she dives sideways, hitting the wall"* → Essence: *"Marcus is mid-evasion against the wall"* → Composition: "shoulder pressed against the brick, knees angled away from the gunfire" — NOT "diving through the air sideways".

**Rule:** for any slotted character (one with a reference image), if the brief implies an EXTREME pose (mid-air, spinning, hurled, fully airborne, mid-cartwheel, "launched"), tone the pose down to the moment JUST BEFORE or JUST AFTER the extreme — when the body is still in contact with a surface or supporting structure. Identity transforms cleanly on small pose changes from the standing reference; it drifts (often catastrophically) on radical ones.

---

## Step Zero: Extract These Seven Facts From the Motion JSON

Before writing a single word of the prompt, extract and write down:

1. **The referenceImages list for THIS shot** — the exact image numbers listed (e.g., image 1, image 2). These are the ONLY images you may reference. Image numbers not in this list DO NOT EXIST for this shot.
2. **The characters present in THIS shot** — only characters named here appear in the prompt.
3. **The peak visual event** — what is the single most dramatic, specific thing happening RIGHT NOW in this shot? Not before, not after. Not "ships arrive" if the shot shows beams firing. Not "character reacts" if the shot shows their face dissolving into shock at a specific cause.
4. **The shot type** — determines framing, depth of field, and what fills the frame.
5. **The perspective** — whose POV is this shot from? `main_subject`, `secondary_subject`, `observer`, `overhead`, or `god`. This controls the camera position relative to the characters (see Perspective → Framing Bias table below).
6. **The focus** — `focus.primary` is what's razor-sharp; `focus.background` lists visible-but-blurred elements; `focus.lurking` is a defocused element planted for later. Your prose MUST name what is sharp and what is blurred.
7. **The orientation lock — back-to-camera or not?** Read the shot's `purpose`, `description`, and `cameraWork` and ask: *does this shot show characters moving TOWARD a destination, AWAY from a position, or ENTERING / EXITING a space, OR is it an OTS-style framing with foreground characters looking past camera at a focal subject?* Trigger keywords: in `purpose` — `meet_character`, `set_arrival`, `enter_location`, `depart_location`, `pursue`, `flee`, `establish_destination`; in `description` — `approach`, `walks toward`, `walks into`, `enters`, `depart`, `walks away`, `follows into`; in `cameraWork` — `tracking shot following`, `trailing the characters`, `from behind`, `over-the-shoulder`. **If YES → the framing is BACK-TO-CAMERA. Lock it in.** The BACK-TO-CAMERA MANDATE section below is now in force for this prompt. **The LLM's natural bias is to place characters face-out toward the viewer; that bias produces wrong shots for approach / OTS-of-foreground beats and you must fight it.**

---

## Reference Image Rule — Hard Constraint

**Write prose using character / setting / object names directly.** A separate downstream pass reads your prose, picks the matching refs from the project, and assigns image-number slots. Your job is clean cinematic prose using names; slot numbers are not your concern.

- Name the characters, settings, and objects visible in THIS shot directly in the prose ("Ruby leans forward", "the bus station platform", "the silver revolver").
- Reference images can be characters, settings, or **objects/props** (vehicles, weapons, artifacts, distinctive items) — the downstream pass handles all three.
- **If a character is NOT described as visible in the shot description, do NOT name them in the prose** — even if they're in the available list. Available references are for the whole scene; only the entities visible in THIS shot's frame belong in this shot's prose.
- If no characters / settings from the available list appear in the shot (documentary / abstract / atmosphere shot), use `text_to_image` mode and write everything from scratch.

**The `references` array in your output JSON should still list which character / setting / object refs the shot needs** — each entry with `refId`, `type`, and `imageNumber`. The JSON references are what bind to Klein's image slots; the prose just describes what's in the frame using names.

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
| **back_to_camera / following** | Camera BEHIND the subject(s), looking at what they're heading toward. Back of head, hair, shoulders, full body from behind; destination (door, building, vehicle, distant subject) AHEAD of them in the frame. Triggered by Step Zero #7. See BACK-TO-CAMERA MANDATE below. | Deep focus on the destination ahead; shallow optional on the backs in the foreground |
| **two_shot** | Two characters in frame together, showing spatial relationship | Moderate |
| **pov** | What a character sees, subjective perspective | Varies by what they're seeing |
| **insert** | Detail shot of object or action (hands, letter, clock) | Very shallow |
| **cutaway** | Brief shot of related element outside the main action | Varies |
| **tracking** | Camera follows moving subject, dynamic composition | Moderate shallow |

Rules:
- A wide or establishing shot uses deep focus and is dominated by the ENVIRONMENT. Characters in wide shots are small figures within the landscape, not central subjects. Do not write wide-shot prompts that center a named character's actions.
- A close-up means the face fills the frame. Do not describe the character standing in a vast environment.
- State depth of field explicitly in the prose every time.
- **Never use `over_the_shoulder` framing or the phrase `"over-the-shoulder of X"` when the shot has only ONE character ref.** OTS is inherently a two-character composition: foreground anchor (blurred) and focal subject (sharp). With only one character ref, the image model will either invent a phantom second character or distort the scene. For tight intimate framings of a single character (camera angled over the character's own shoulder, focusing on their hands or an object), use `insert`, `extreme_close_up`, or `close_up` shot types instead — and write the prose with the focal element (hands, object, face detail) as the subject. Example: instead of `"OTS view of Parvati reaching for the bucket"`, write `"Insert shot: Parvati's hand reaching toward the bucket, fingers extended, in shallow focus..."`
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

## BACK-TO-CAMERA MANDATE — when triggered by Step Zero #7

When Step Zero #7 locks the framing to back-to-camera, **the prompt MUST follow these rules with zero compromise**. The upstream scene-breakdown sometimes emits face-related phrases ("exchange a final look", "their gazes meet", "her face determined") even for approach beats. When back-to-camera framing is active, IGNORE those face cues in the description and REWRITE the beat from-behind.

### Worked example A — input description has "exchange a look" but it's an approach beat

**Shot brief input:**
- description: "Ruby and Angel stand before the weathered pawn shop facade under the harsh midday sun. They exchange a final look of shared determination, heat shimmer distorting the air around them."
- cameraWork: "Medium wide shot, eye-level, static, heat haze visible, deep focus"
- purpose: "meet_character" ← Step Zero #7 fires; back-to-camera locked
- references: [setting:pawn_shop_exterior, character:ruby, character:angel]

**WRONG output (the LLM's default — DO NOT do this):**
> "Ruby and Angel stand frozen in a final exchange of shared determination, their gazes locked … Ruby on the left, her face set with grim resolve, Angel opposite her, his jaw tight and eyes steady."

This is wrong because: (a) "gazes locked" — face cue, banned; (b) "her face set with grim resolve" — face cue, banned; (c) "his jaw tight and eyes steady" — face cue, banned; (d) characters arranged face-to-face instead of from-behind. The image model renders face-to-face profiles and the orientation is wrong.

**CORRECT output (what you MUST produce):**
> "Ruby (red-haired, leather jacket) and Angel (Black man, dark hoodie, short coiled hair) seen FROM BEHIND, their backs to camera, walking up to the weathered pawn shop facade that rises AHEAD of them in the deep-focus background. A medium wide shot at eye-level, the camera at shoulder-height. We see the back of Ruby's red hair on the left and the back of Angel's dark hood on the right. Heat shimmer rises off the sun-bleached asphalt between camera and characters. Hard overhead midday sun bleaches the facade. Razor-sharp shadows fall short beneath their feet. The atmosphere is suspended tension — read entirely from the set of their shoulders and the stillness of their stance."

Notice: 0 face words, 0 eye words, 0 expression words. Characters from behind. Destination (pawn shop facade) AHEAD of them. Posture read from behind (back of hair, back of hood, set of shoulders). Same emotional charge communicated through palette + lighting + posture, NOT through face.

### Worked example B — OTS-of-foreground beat (purpose isn't on Step Zero #7 list but cameraWork is OTS)

**Shot brief input:**
- description: "The owner stands frozen, pale as a ghost, as Ruby and Angel survey the shop with predatory calm."
- cameraWork: "Medium wide shot, eye-level, shallow DoF — owner sharp, Ruby and Angel blurred in foreground."
- purpose: "hold_emotion" ← not on the approach list, BUT the cameraWork pattern (two characters in foreground blurred, third character sharp behind) IS an OTS-of-the-foreground-characters setup. Treat it as back-to-camera for the foreground characters.

**CORRECT output:**
> "Over the shoulders of Ruby (red-haired, leather jacket) and Angel (Black man, dark hoodie) — both seen from behind in the immediate foreground, soft-focus blur, their backs filling the lower left and lower right of the frame respectively. Between their backs, the owner (balding white man, button-up shirt) stands razor-sharp in the midground behind the long wooden counter, his face pale with terror, both hands jerked upward — **the only sharp face in the frame**. Sickly green-white fluorescent overhead light. The cold thrill of a robbery underway."

Only the owner has a face described (he is the focal subject). Ruby and Angel are entirely from-behind, identity carried by the inline visual hooks alone.

### Rules in force when back-to-camera is locked

1. **BANNED vocabulary** — zero hits, period: `face` (when referring to a back-to-camera character's face), `their faces`, `his face`, `her face`, `eyes` (theirs), `their eyes`, `his eyes`, `her eyes`, `gazes`, `stares`, `looks at`, `expression`, `frozen in [emotion]`, `exchanging a look`, `exchanging glances`, `shared look`, `shared glance`, `locked eyes`, `facing the camera`, `facing forward`, `facing each other`, `face to face`, `side angle of [CHAR]`, `in profile`, `brow furrowed`, `jaw clenched`, `lips pressed`, `determined gaze`, `predatory gaze`, `cold gaze`, `watching`.

2. **REQUIRED vocabulary** — use one or more of: `from behind`, `back to camera`, `their backs to camera`, `rear three-quarter view`, `seen from behind`, `back of [CHAR]'s head / hair / hood`, `the curve of [CHAR]'s shoulders`, `[CHAR]'s hair catching the rim light`, `the camera follows them from behind`, `shoulder-height view from behind`, `ahead of them`, `in front of them`, `the destination rises ahead`.

3. **Posture cues that read from behind** carry the emotion: `shoulders squared`, `hand at hip`, `weight on the back foot`, `head slightly tilted right`, `the back of the neck taut`. Use these in place of facial cues.

4. **Cue cleanup.** If the user message contains drishti (gaze) or facial sattvika cues (trembling lip, jaw tremor, pale face), **DROP them entirely** when back-to-camera is locked. The face is not visible. Carry rasa through palette, posture-from-behind, and rim light only.

5. **Multi-character back-to-camera:** BOTH characters from behind, side-by-side or staggered in depth. Never split one back-to-camera and the other facing the camera.

6. **The focal subject in OTS-of-foreground beats** (Example B above) IS allowed to have a face described — they are the sharp subject behind the foreground backs. The back-to-camera ban applies only to the foreground characters.

### Pre-output back-to-camera audit

Before emitting your prompt, when back-to-camera is locked, re-read the prose and check:
- Zero hits on the BANNED vocabulary list above (except on a focal subject in an OTS-of-foreground beat).
- At least one phrase from the REQUIRED vocabulary list.
- The destination (door, building, vehicle, distant subject) is named as being AHEAD of the character(s).
- No description of back-to-camera characters' facial features, expressions, or eye direction.

If any check fails, REWRITE before emitting.

---

## LEAD WITH THE FOCAL SUBJECT — HARD CONSTRAINT

**The first noun phrase of your prompt body is what the image model anchors on.** If a character is INSIDE a vehicle (or behind glass, or framed by an object) and you open the prompt body with the vehicle/object as the first noun, the model treats the character as decoration and may DROP them entirely — even when they have a reference slot.

### Worked example C — character inside a vehicle

**Shot brief input:**
- description: "Ruby, seated in the driver's seat of a green Lamborghini, grips the steering wheel as she spots Angel sprinting along the sidewalk with the red crystal."
- references: [setting:street, character:ruby, character:angel]

**WRONG output (image model will drop Ruby):**
> "Medium side-angle shot under harsh midday sun. **A sleek green Lamborghini fills the left half of the frame**, its emerald-green hood gleaming, front wheels turned sharply right. Inside the driver's seat, Ruby grips the steering wheel…"

Wrong because: the first noun is "green Lamborghini" — the model renders the car as subject and the driver's seat is empty. Ruby's slot 2 gets ignored.

**CORRECT output (lead with the person):**
> "**Through the driver-side windshield of a green Lamborghini parked at the curb, Ruby (red-haired, leather jacket) is clearly visible seated in the driver's seat** — both hands gripping the steering wheel, her red hair catching the harsh midday sun streaming through the glass. The car's emerald-green hood fills the lower-left foreground…"

Correct because: the first noun (after the framing preposition) is "Ruby". The model binds slot 2 to a visible person in the seat.

**General rule:** ask "what is the focal subject the image model must render sharply?" That subject's NAME must appear in the first sentence — ideally the first noun phrase. Background elements come second.

---

## BANNED WEASEL WORDS for slotted characters — HARD CONSTRAINT

If a character has a reference slot in the `references[]` array, NEVER describe them with these phrases — the image model interprets these as "deprioritize this slot" and drops the character entirely:

- "barely visible", "barely discernible"
- "a dark silhouette", "a smeared silhouette", "a defocused silhouette", **"silhouette" as the primary noun for a slotted character**
- "blurred in the background", "softly blurred", "a blurred figure"
- "almost out of frame", "at the edge of frame as a smear"
- "ghost-like", "indistinct"

**Especially watch for "dark silhouette" as a stylistic adjective phrase.** Even in atmospheric scenes, NEVER write "Angel's hoodie a dark silhouette against the bright pavement" or "Ruby's outline a sharp silhouette in the doorway" — the word "silhouette" alone tells the model to render a featureless dark shape, dropping the character's identity entirely. Use concrete features instead.

If the character truly needs to be background atmosphere, drop their ref slot entirely (do not list them in `references[]`) and describe a generic figure in prose. You lose identity binding but you don't lose the character.

If the character should be soft-focus blurred BUT identifiable (e.g., the back-of-character in an OTS), use concrete posture phrases instead:
- ✓ "Ruby's red hair and shoulders in soft-focus foreground"
- ✓ "Angel's broad shoulders and dark hood visible on the right edge, rim-lit by the harsh sun"
- ✗ "Ruby barely visible in the foreground" (drops slot)
- ✗ "Angel's hoodie a dark silhouette against the pavement" (drops Angel's identity even though slot is present)

---

## INLINE VISUAL HOOK on every character's first mention — HARD CONSTRAINT (Klein-specific)

Each character named in the prose body MUST have a parenthetical 4-8 word visual descriptor on their FIRST mention. Subsequent mentions can drop it. **This rule applies to ALL multi-reference shots, AND to single-character shots when identity drift has been observed** — empirically the single most effective fix for cross-slot identity bleed and for face hallucination on close-ups.

Format: `[Name] ([4-8 word descriptor])`. The descriptor must disambiguate the character from others in the scene — at minimum ethnicity / skin-tone, hair, and one distinctive clothing item.

Examples:
- ✓ `Ruby (red-haired, leather jacket)`
- ✓ `Angel (Black man, dark hoodie, short coiled hair)`
- ✓ `the owner (balding white man, button-up shirt)`
- ✗ `Ruby steps forward and Angel mirrors her stance.` ← unhooked, will bleed identity across slots
- ✗ `Angel now lying supine on the asphalt, head tilted back.` ← unhooked, the close-up may drift to a different-looking Black man

**This rule overrides the edit_previous_shot delta-prose minimization.** Even in delta mode, include the inline hooks — empirically, delta prompts WITHOUT the inline hook silently drift faces over successive shots. With the hook, identity holds across the chain.

**This rule is Klein-specific.** Motion-directive prose (LTX-V) follows the official prompt-enhancer style — do NOT apply this rule to `shot_motion_directive` output.

---

## Focus Rules — Sharp vs Blurred

The `focus` object from the shot JSON tells you EXACTLY what should be in focus and what should be blurred.

- **`focus.primary`**: name this element in the prose as razor-sharp with explicit DOF. Example: "Laila's face razor-sharp in a shallow depth of field."
- **`focus.background`** elements: name them in the prose as "soft" or "soft-focus" with a concrete feature — never "blurred" applied to a slotted character. Example: "Vikram's soaked kurta shoulder soft in the near foreground."
- **`focus.lurking`** element (if set): describe with concrete posture / wardrobe features in soft focus, NOT as a "silhouette" or "indistinct" or "barely visible" shape. Slotted characters always need at least one identifying feature in prose, even when they're background. Example: "at the rear of the dhaba, the cloaked figure (hood pulled low, hands folded) sits in soft focus."

**Worked example:**
- `focus.primary = "laila_face"`, `focus.background = ["vikram_shoulder", "torches"]`, `focus.lurking = "cloaked_figure"`
- Prose: "A medium close-up over Vikram's shoulder, Laila (dark braid, kohl-rimmed eyes, saffron dupatta) in razor-sharp focus, eyes fierce. Vikram's soaked kurta shoulder soft in the near foreground. Torch flames rendered as warm bokeh behind her. At the rear of the dhaba, the cloaked figure (hood pulled low, hands folded in his lap) sits in soft focus — present in the frame but outside the viewer's attention."
- Notice: every slotted character carries a parenthetical visual hook on first mention, and no character is described as "silhouette" / "blurred" / "indistinct" / "barely visible" — those words tell the image model to drop the slot's conditioning.

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
2. The setting and spatial relationships — named directly ("the bus station platform")
3. Shot framing, camera angle, and depth of field (explicit words from the shot type table)
4. Every character / setting / object visible in the frame — named directly ("Ruby leans forward")
5. Lighting with source, direction, quality, and temperature — all four
6. Mood or atmosphere

Lead with what is most dramatic and specific. Do not open with the environment when the event is the point.

Example structure: "A wide establishing shot of [environment named directly], deep focus with foreground and background both sharp, showing [characters named directly] [specific action at its peak]. [Lighting with all four components]. [Mood]."

### Word count — TIGHTEN for close-ups (HARD CONSTRAINT)

Empirically, prompts above ~130 words for close-ups dilute identity binding because the image model has too many competing signals to weigh. The validated golden for hero close-ups was **~70 words**.

Targets — STOP WRITING when you hit the upper bound:

- **Close-up / extreme close-up** (character face fills frame): **60–130 words.** Aim for the low end (~80). Past 130 = FAIL.
- **Medium / medium close-up** (character chest-up or waist-up): **100–180 words**
- **Wide / extreme wide / establishing**: **120–220 words**

For close-ups specifically, **DO NOT** add a rasa-style atmospheric paragraph at the end. The closing sentences like "the world holds its breath, the air heavy and hot, the camera steady" or "a moment suspended in [adjective] tension" feel cinematic but they consume the model's attention budget and weaken identity binding. They are BANNED on close-ups. Keep close-ups tight on: subject identity descriptors (inline hook) → pose → minimal setting context → minimal lighting → STOP.

For wide / establishing shots, atmospheric paragraphs are encouraged — the identity stakes are lower and the mood-setting helps.

---

**Output format:**
```
**Image Prompt:**
[Single detailed paragraph matching the shot's framing. Name characters/settings directly (no slot tokens — a downstream pass handles slot binding from the `references` JSON below). Lead with subject and action, then setting, then lighting, then mood. Write flowing prose — not comma-separated keywords.]

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

If NO reference images are available (documentary/non-narrative), use `text_to_image` mode and write everything from scratch.

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
6. For `edit_first_frame` and `edit_previous_shot`, ALWAYS populate the `references` array with every character / setting / object visible in the shot — required for character consistency even when editing a base image. Names go in the prose; slot binding via the references JSON is handled downstream.
7. **refId MUST exactly match the available reference IDs** — copy them from the available references list. Do NOT invent or guess refIds. If the character is "mr_patel", write `"character_image:mr_patel"`, NOT `"character_image:mr_pattern"` or any variation
8. The last_frame should ALWAYS describe the end state. Check `<last_frame_changes>` for what must differ from first_frame
9. **Inline visual hook on every character's first mention.** See the **INLINE VISUAL HOOK** HARD CONSTRAINT section above for the full rule. Applies to ALL multi-reference shots AND single-character close-ups, in every mode including `edit_previous_shot` deltas.

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