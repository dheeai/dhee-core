**PURPOSE**: Expand a single shot from a pre-approved scene plan into its full breakdown. The plan has already decided shot count, ordering, purpose, and duration — your job is to fill in cameraWork, perspective, focus, audio, and transition for ONE shot. **Do not change the plan's `shotNumber`, `purpose`, or `duration`.** Treat them as inputs, not suggestions.

You will receive:
- `<scene_plan>`: the full Stage A plan for the whole scene (so you have continuity context — what came before this shot and what comes after).
- `<this_shot>`: the single plan entry you are expanding (`shotNumber`, `purpose`, `duration`, `oneLineSummary`, optional `perspective` and `continuityRole`).
- `<available_refs>`: the canonical refId list for this project.

Output a SINGLE shot object matching the `<json_schema>` provided in your system prompt.

---

## Canonical refIds — USE EXACTLY, NEVER INVENT

Whenever you write a character, setting, or object reference — `perspectiveOf`, `focus.primary`, `focus.background[]`, `focus.lurking` — you MUST use the exact refId string from the `<available_refs>` block.

Do NOT paraphrase, normalize casing, drop punctuation, or "fix" spellings. The refId is a database key — if a refId in `<available_refs>` contains an apostrophe or other punctuation, preserve it exactly. Downstream code looks up per-item nodes by these exact strings; any mismatch silently breaks reference image resolution.

If this shot needs an entity that isn't in `<available_refs>`, describe it by prose in `description` instead of referring to it by refId. Never invent a refId.

---

## Character Identity Preservation — CRITICAL

Every character has a profile file (e.g. `characters/angel.md`) that establishes their immutable identity: gender, age, ethnicity, physical features, name. **You MUST preserve this identity exactly** — particularly gender and pronouns — in every shot you write for that character.

**The bug to avoid:** the LLM sometimes pattern-matches the scene's genre (heist with female mainSubject → "Thelma & Louise") and drifts the pronouns of secondary characters to match the dominant gender of the scene. This is a hallucination — the character profile takes precedence over genre intuition, always.

### Rules

1. **Pronouns must match the profile.** If the character profile says "Black African male, his loyalty, he betrays Ruby," every pronoun referring to that character in your `description`, `cameraWork`, and `audio` must be `he` / `him` / `his`. Never `she` / `her` / `hers`.

2. **Never write "both women" / "both men" / "the women" / "the men"** without verifying every character in the group matches that gender per their profile. Mixed-gender groups must be written as such ("Ruby and Angel," "the pair," "the couple").

3. **When in doubt, use the refId or the proper noun.** Writing "Angel kicks the door open, Angel sweeps the room with the gun" is clunky but correct. Writing "She kicks the door open" when Angel is male is a content bug that propagates through the entire pipeline.

4. **The mainSubject's gender does NOT override secondary characters.** Scene 2's mainSubject may be Ruby (female), but Angel remains male per his profile.

### Pre-output pronoun audit — RUN BEFORE OUTPUTTING

For every character refId mentioned in this shot's `description`, `cameraWork`, or `audio`:

1. Open their profile (already in your context as `<available_refs>` or the linked character file).
2. Note their declared gender / pronouns.
3. Scan your prose: every pronoun within ~10 words of that character's name or refId must match the profile.
4. If mismatched, REWRITE — use the proper noun, the refId, or the correct pronoun.

If you find yourself writing "she" or "her" for a male character (or "he" / "him" for a female character), stop and rewrite the entire sentence. The error compounds — once you flip a pronoun, the LLM tends to keep using the wrong one in subsequent shots.

---

## Reference cap per shot — 4 maximum

Across the union of references this shot pulls in via `focus.primary`, `focus.background[]`, `focus.lurking` (plus the scene-level `mainSubject` / `secondarySubject` when they appear in this shot), a single shot must reference at most 4 distinct entities. The image generator has 4 reference slots total. Slot 1 is reserved for the setting (the base canvas). Drop priority when over: extra settings first (keep one), then non-mainSubject characters, then the secondary subject. Never put a character in `focus.background[]` purely as decoration — it costs a slot.

---

## Required Fields — No Exceptions

Every shot object MUST contain these fields. Missing or empty fields = broken output.

| Field | Type | Description |
|---|---|---|
| `shotNumber` | number | **Copy from `<this_shot>` — do not change.** |
| `purpose` | string | **Copy from `<this_shot>` — do not change.** |
| `duration` | number | **Copy from `<this_shot>` — do not change.** Already calculated for dialogue fit. |
| `description` | string | 1–2 sentence visual brief — expand the `oneLineSummary` |
| `cameraWork` | string | Start with framing, then angle and movement |
| `audio` | string | Everything heard — dialogue, ambient, effects, or silence |
| `transition` | string | How this shot transitions FROM the previous shot |

Recommended (set when meaningful): `perspective`, `perspectiveOf`, `focus`, `continuityRole`.

```json
{
  "shotNumber": 1,
  "purpose": "set_the_mood",
  "duration": 4,
  "description": "<expand the oneLineSummary into a 1–2 sentence visual brief naming a specific sensory detail from the scene script>",
  "cameraWork": "<framing>, <angle>, <movement>, <DOF cue>",
  "audio": "<dialogue with NAME: prefix OR ambient cues OR silence>",
  "transition": "<cut|fade|dissolve|whip_pan|dip_to_black|continuous>",
  "focus": { "primary": "<refid_or_short_prose>", "background": [] },
  "continuityRole": "<entry|exit|bridge|none>"
}
```

(The `<...>` tokens are placeholders — substitute concrete values drawn from `<this_shot>`, `<scene_plan>`, the scene script, and `<available_refs>`. Never copy the placeholder strings into your output.)

---

## Dialogue — Fit the Pre-Allocated Duration

The plan has already set `duration` to fit the dialogue word count. Your job is to:

1. Place the dialogue in `audio` with the correct `NAME:` prefix.
2. Verify the line you write fits within the `duration` you were given (rate of ~2.5 words/sec, +1s buffer).
3. **One speaker per shot** — `audio` must contain at most ONE `NAME:` pattern. Ambient sound after the dialogue is fine ("cicada hum, distant traffic"), but never a second speaker.
4. If the dialogue you'd need to write doesn't fit `duration`, that's the plan's bug — flag it via the description but do not change `duration`. Trim the dialogue to fit if you can do so without losing meaning.

---

## Perspective — WHOSE POV IS THIS SHOT FROM

Every `show_action` and `meet_character` shot MUST declare `perspective`. Other shots SHOULD declare it when meaningful.

| Perspective | When to use |
|---|---|
| `main_subject` | POV or over-the-shoulder of the scene's mainSubject. **Default flow — majority of shots.** |
| `secondary_subject` | POV or OTS of secondarySubject. Use for reaction reversals in dialogue. |
| `observer` | Neutral third-person. Use when neither character's viewpoint should dominate. |
| `overhead` | High-angle/birds-eye looking down. Use for spatial establishing or subject-feels-small moments. |
| `god` | Impossible omniscient viewpoint. Reserve for scale moments. |

**Flow rules:**
- Shots should GENERALLY follow the mainSubject — non-overhead perspectives default to `main_subject` unless the story calls for a reversal.
- When the mainSubject is meeting a new character, use `main_subject` perspective (we see through THEIR eyes as the other person enters).
- Reserve `overhead`/`god` for specific spatial or tonal moments, not casual use.
- For dialogue scenes, alternate `main_subject` and `secondary_subject` to create the shot/reverse-shot rhythm — check `<scene_plan>` for what the previous shot used.

**Hard rule — NEVER write `over-the-shoulder` (or OTS) into `cameraWork` when only ONE character is in this shot.** OTS is inherently a two-character composition: foreground anchor (blurred) + focal subject (sharp). With a single character, the image model either invents a phantom second character or breaks focus. For tight intimate framings of one character (camera angled over their own shoulder, focusing on hands or an object), use `insert`, `extreme_close_up`, or `close_up` in `cameraWork` instead — and write the subject as the focal element (hands, object, face detail), not the character themselves. The `perspective` field can remain `main_subject` for these intimate single-character shots; just don't pair it with OTS framing in `cameraWork`.

**`perspectiveOf` field:** If the shot's perspective is tied to a specific character, set `perspectiveOf` to their refId. When omitted and perspective is `main_subject`, it defaults to `mainSubject`.

---

## Focus — WHAT'S SHARP VS BLURRED

The `focus` object (recommended for non-establishing shots) specifies what's razor-sharp and what's defocused:

```json
"focus": {
  "primary": "<refid_of_focal_subject>",
  "background": ["<refid_of_object_in_frame>", "<refid_of_secondary_subject>"],
  "lurking": "<refid_of_later_payoff>"
}
```

(The `<...>` tokens above are placeholder names — substitute the actual refIds from `<available_refs>`. DO NOT write these placeholder strings into your output.)

- **`primary`** (required if focus is used): what's razor-sharp — refId preferred, short prose allowed for non-ref objects (e.g., `"the torn letter"`, `"the cracked tile"`).
- **`background`**: visible but blurred elements — characters/objects we can see but are not the focal point.
- **`lurking`** (optional): a defocused element planted for a later focus-pull. If this shot's `lurking` names something, a later shot in `<scene_plan>` should pull `focus.primary` to that same element for the payoff.

**Use focus to:**
- Create visual priority — who/what should the viewer look at?
- Plant future tension — lurking elements become important later.
- Give shot composition specific DOF guidance for the downstream image step.

---

## Continuity Bridging — NO TELEPORTING

`continuityRole` (copy from the plan's entry if set; otherwise default `none`):
- `entry` — main subject arrives in a new location
- `exit` — main subject leaves a location
- `bridge` — travel/montage beat between locations
- `none` (default) — not a bridging shot

Inspect `<scene_plan>` for the previous and next shots. If the main subject's location is changing, ensure your shot's framing supports the bridge: an `exit` shot shows them at the threshold; an `entry` shot shows them arriving.

---

## Description Field

The `description` field is a brief 1–2 sentence summary of what happens in this shot. Capture:
- The main action or event
- Who is involved
- The emotional beat

This is NOT a detailed image prompt — keep it concise. The downstream `shot_image_prompt` step expands this into full frame descriptions with cinematographer prose.

### Approach / entry / depart beats — write back-to-camera-friendly descriptions

When this shot's `purpose` is one of `meet_character`, `set_arrival`, `enter_location`, `depart_location`, `establish_destination`, `pursue`, or `flee` — OR when the `oneLineSummary` / your description-in-progress involves characters MOVING TOWARD, AWAY FROM, INTO, or OUT OF a place — write the `description` so the downstream image-prompt step naturally renders the characters **from behind, walking toward the destination**.

**The downstream image-prompt LLM trusts your `description` prose over its own framing rules.** If you write "they exchange a final look of shared determination," the downstream prompt will render face-to-face profiles, even though the shot is an approach beat and should be back-to-camera. Your wording IS load-bearing.

**Use these phrasing patterns:**
- ✓ "Ruby and Angel walk up to the weathered pawn shop entrance from the sidewalk, both seen from behind, approaching the door under the harsh midday sun."
- ✓ "Marcus enters the cathedral from the western nave, walking toward the altar visible at the far end of the deep-focus background."
- ✓ "Elena departs the diner, her back to camera, the empty booth receding behind her as she pushes through the glass door."

**AVOID for approach / OTS-of-foreground beats:**
- ✗ "Ruby and Angel exchange a final look of shared determination" (face cue — wrong for an approach beat)
- ✗ "Their gazes meet as they stand before the entrance" (gaze direction implies facing camera/each other)
- ✗ "Her face set with determination, his jaw tight with resolve" (face features — wrong for back-to-camera)
- ✗ "Eyes locked on the door ahead" (eyes are a face feature — describes the action correctly but biases the downstream prompt)

If the emotional beat is "shared determination before they break in," describe it via **posture and approach** ("walking together in lockstep, shoulders squared, weight forward — a pact held in the silence of the approach"), NOT via faces and gazes. Posture cues survive the back-to-camera framing; face cues don't.

### OTS-of-foreground beats — same rule

When this shot's `cameraWork` places two characters BLURRED in the foreground with a third character SHARP behind them (the classic over-the-shoulder-of-the-robbers setup), the foreground characters' description must be back-to-camera. Write `description` accordingly:
- ✓ "Over Ruby and Angel's shoulders (both seen from behind in the blurred foreground), the owner stands frozen behind the counter, hands raised in surrender, face pale with terror."
- ✗ "Ruby and Angel survey the shop with predatory calm as the owner stands frozen behind the counter." (the survey/calm framing biases Ruby+Angel to face-on)

The focal subject (the owner here) IS allowed face cues — they are the sharp subject the viewer sees clearly. The back-to-camera constraint applies only to the foreground characters.

---

## Audio Field

The `audio` field captures **everything heard** in a shot — dialogue, ambient sound, effects, and silence — in a single field. Never leave it empty.

**Format rules:**
- **Dialogue**: prefix with character name in caps: `"ELENA: Don't follow me. Rain on pavement, footsteps receding"`
- **Voiceover**: prefix with V.O.: `"ELENA (V.O.): I should have known. Soft piano underscore"`
- **Ambient only** (no dialogue): `"wind through trees, distant sirens"`
- **Explicit silence**: `"silence"` or `"near-silence, faint hum of fluorescent lights"`
- **Multiple elements**: combine with commas: `"MARCUS: Stay here. Thunder crack, rain intensifying, door creaking shut"`

**Rules:**
- Every shot MUST have a non-empty `audio` field
- AT MOST ONE `NAME:` pattern per shot. If the plan's `oneLineSummary` mentions two speakers, that's a plan bug — emit ONE speaker's line in this shot.
- If a shot has no dialogue, describe the ambient sounds or effects heard

---

## Transitions

Every shot MUST have a `transition` field. No exceptions.

Each shot specifies how it transitions FROM the previous shot. **The scene-boundary transition lives on the FIRST shot of the new scene** — that shot's `transition` field describes the cut from the previous scene's last shot into this scene.

**Transition types:**
- **`cut`** — hard cut. Default for within-scene shot-to-shot under continuous action
- **`crossfade`** — smooth dissolve. Use for time passing, dreamlike moments, parallel action
- **`fade`** — fade through black. Use for scene openings, significant time jumps, finality
- **`dip_to_black`** — fade out > brief black hold > fade in. Trailer "breather" beat. Use between scenes or to punctuate dramatic moments
- **`flash_to_white`** — quick white flash. Use for impact moments, explosions, revelations, smash cuts
- **`circle_close`** — contracting circle (blink/iris effect). Use for POV shots, dreamy or surreal moments
- **`circle_open`** — expanding circle reveal. Use to open a new location or reveal a surprise
- **`wipe_left`** / **`wipe_right`** — directional wipe. Use for location changes, parallel storylines, comic/graphic style

**Rules (highest priority first):**

1. **Scene-boundary rule** — when this shot's `continuityRole` is `entry`, the transition MUST be a SOFT transition: `fade`, `dip_to_black`, `crossfade`, or `circle_open`. NEVER `cut`. The post-LLM normalizer auto-corrects `entry` + `cut` to `fade`, so picking `cut` here just produces a less-considered version of the right thing.
2. **First shot of scene 1** — use `fade` (opening from black).
3. **Within-scene default** — most shots are `cut`. Transitions are seasoning, not the main course.
4. **Add variety where it earns it** — across a scene, at least one or two transitions should NOT be `cut` if any of the following apply: a clear time-passing beat (`crossfade`), an emotional spike (`flash_to_white` for shock; `dip_to_black` for a held dramatic pause), an introspective shift (`circle_close`), or a location reveal mid-scene (`circle_open`, `wipe_left`/`wipe_right`). A scene where every single shot is `cut` is acceptable for a relentless action sequence, but rare in practice — re-read the scene and ask whether any beat would breathe better with a softer transition.
5. **Match transition to emotional beat** — `flash_to_white` for shock, `crossfade` for tenderness, `circle_close` for introspection.

---

## Camera Work

- Start with framing: wide, medium, close-up, extreme close-up
- Then add angle and movement: "close-up, low angle, slow push-in as tension builds"
- Keep it concise — a short phrase, not a paragraph
- Match the framing to `purpose` — `set_the_world` should be wide; `show_reaction` should be close-up; `show_dialogue` is typically medium or close-up

---

## Pre-Output Checklist — RUN EVERY ITEM

Before returning JSON:

1. **`shotNumber`, `purpose`, `duration` copied verbatim from `<this_shot>`** — not changed
2. **`description` is 1–2 sentences**, expands the plan's `oneLineSummary`
3. **`cameraWork` starts with framing**, then angle/movement
4. **`audio` is non-empty**; if it contains `NAME:` or `(V.O.):`, only ONE speaker
5. **`transition` is set** — `fade` for first shot of scene 1; SOFT transition (`fade` / `dip_to_black` / `crossfade` / `circle_open`) whenever `continuityRole='entry'`; otherwise typically `cut` (but consider variety per Transitions Rule 4)
6. **If `purpose` is `show_action` or `meet_character`**, `perspective` is set
7. **For non-establishing shots**, `focus.primary` is set
8. **Every refId** (`perspectiveOf`, `focus.primary`, `focus.background[]`, `focus.lurking`) appears verbatim in `<available_refs>`
9. **Reference count ≤ 4** across `focus.primary`, `focus.background[]`, `focus.lurking`, plus mainSubject/secondarySubject if they appear in this shot
10. **`continuityRole`** matches the plan's hint when set; otherwise default `none`
11. **OTS framing** never paired with a single-character shot — use `insert` / `extreme_close_up` / `close_up` instead
12. **Bharata tags preserved from Stage A** — if the plan entry for this shot includes `sattvika`, `drishti`, or `vyabhichariBhava`, copy them through into the expanded shot JSON. You MAY add or refine these tags when the expanded prose makes them obviously appropriate, but you MUST NOT silently drop tags Stage A set.
13. **Pronouns match the character profile** — for every character refId mentioned in `description` / `cameraWork` / `audio`, the pronouns within ~10 words of their name must match the gender declared in their character profile. Never write `she` / `her` for a male character (or vice versa) because the scene's mainSubject is the opposite gender. Re-roll the sentence using the proper noun if you find a mismatch.
14. **Approach / entry / depart beats — back-to-camera-friendly description.** If `purpose` ∈ `{meet_character, set_arrival, enter_location, depart_location, establish_destination, pursue, flee}` OR the description involves characters moving TOWARD / AWAY FROM / INTO / OUT OF a place, the `description` MUST be written so the downstream image-prompt step naturally renders the characters from behind. Re-read your `description` and reject face-cue phrases like "exchange a look", "gazes meet", "face set with", "eyes locked on" — rewrite using posture and approach phrasing (see the "Approach / entry / depart beats" section above). The downstream LLM trusts your `description` prose over its own framing rules, so this wording is load-bearing.

---

## Bharata Framework — Per-Shot Expansion

The Stage A plan supplies the scene's `rasa` and (optionally) per-shot Bharata tags. At Stage B you must:

1. **Honor the scene's rasa** when writing `description`, `cameraWork`, and `audio`. The rasa's palette/lighting/pacing prescription steers prose tone — see Stage A guide for the rasa table.
2. **Preserve and physicalize Stage A tags.** If the plan says `sattvika: "vepathu"` for this shot, the description must SHOW the trembling (white knuckles, tremor in the hands, spear shaking). If `drishti: "roudri"`, the description must SHOW fierce predatory eyes (narrowed, fixed, predator-like). The tag alone is not enough — it must surface in the prose so downstream image-prompt generation has something concrete to render.
3. **You may add a Bharata tag** at Stage B when an emotional micro-cue is clearly present in your description but wasn't in Stage A's plan. Use the canonical enums only.

### Canonical enums — DO NOT invent values

- **`sattvika`**: `vepathu`, `sveda`, `stambha`, `romancha`, `vaivarnya`, `ashru`
- **`drishti`**: `sama`, `alokita`, `sachi`, `nimilita`, `unmilita`, `kuncita`, `roudri`, `lalita`
- **`vyabhichariBhava`**: `smriti`, `cinta`, `sanka`, `nirveda`, `harsha`, `autsukya`, `garva`, `glani`, `lajja`

Common error: writing `bhaya` or `krodha` for `vyabhichariBhava`. Those are sthayi-bhavas (the persistent ground), not transient flickers — they belong on the scene's `sthayi` field, NOT on a shot.

### Camera / lens bias by scene rasa

When `cameraWork` is otherwise free, bias defaults by the scene's rasa:
- `shanta`, `karuna` → static or imperceptibly slow drift; medium-telephoto compression; shallow DOF on face.
- `raudra`, `bhayanaka` → handheld permissible; whip pans on reveal; wider lens with optical distortion welcome.
- `veera` → low-angle push-in on resolve beats; tracking on action.
- `adbhuta` → slow rise/reveal; symmetric framing; layered atmosphere.
- `shringara` → soft push-in; golden-key light cue; shallow DOF.

Override these defaults only when the specific beat genuinely demands it.
