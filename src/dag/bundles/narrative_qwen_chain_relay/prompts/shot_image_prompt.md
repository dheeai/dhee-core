You are writing a CHAIN-EDIT instruction for Qwen Image Edit 2511 with the Multi-Angles LoRA stacked on top. The runner will take a prior shot's image as the base and apply your edit instruction to produce the next shot's first frame.

## Inputs

Shot data:
{{scenes_plan}}

World style:
{{world_style}}

Available character references:
{{characters_plan}}

Available setting references:
{{settings_plan}}

## Your job

You output a JSON object with these fields:

- `characters`: **array of character IDs** (max 2). List the characters who VISUALLY APPEAR in this shot's first frame, in order of prominence — primary subject first, secondary character second. Use the snake_case `id` from `characters_plan` verbatim (e.g. `"pawn_shop_owner"`, NOT `"the owner"` or `"Pawn Shop Owner"`). The runner uploads these images as Qwen Edit reference slots; slot 1 binds the model's cross-attention tightest, so the most-on-screen character belongs there. Empty array `[]` is fine for insert shots of objects with no character in frame. **Do not** include characters who are only mentioned but not visually present (e.g. a heard-off-screen yell).
- `chosenBaseShotNumber`: **integer** OR **null**. Of the prior shots listed above, pick the ONE whose framing best supports the current shot's intended composition. Examples:
   - If shot 5 is a CU on a hand and shot 3 was the last medium two-shot of both characters, and the current shot needs a wide two-shot — pick **3**, not 5. The CU has too little scene context.
   - If the current shot is a continuation (e.g. dialogue between same two chars, slight reframe) — pick the most recent shot (highest shotNumber).
   - If this is shot 1 of the scene (no priors), use `null`.
- `chosenBaseReason`: ONE short sentence explaining why.
- `view`, `elevation`, `distance`: pick from the enums (the LoRA only recognizes exact tokens). **Critical**: emit the LITERAL token string from the enum, not a paraphrase. E.g. `"close-up"` ✓ not `"medium close-up"` ✗ or `"extreme close-up"` ✗.
- `deltaText`: 2–5 sentences describing what CHANGES from the chosen prior shot to THIS shot — new actions, character entries/exits, expression changes, camera motion. **Do NOT restate things that haven't changed** (same setting, same characters' clothing, same lighting). **Do NOT prepend `<sks>`** — the runner assembles it.

## Choosing camera tokens

**The first frame represents the OPENING moment of the shot.** When `cameraWork` describes a compound shot (e.g. "X then Y", "POV pan then close-up"), pick tokens that match the OPENING framing X, NOT Y. The shot's later moments are captured by the video model from the motion directive; your job is the first frame only.

**Mapping common cinematography vocabulary to LoRA tokens:**

| Source cameraWork phrase | Emit |
|---|---|
| `extreme wide`, `extreme_wide`, `long shot`, `establishing` | `wide shot` |
| `medium wide` | `wide shot` (or `medium shot` if subject dominates the frame) |
| `medium close-up`, `medium close up`, `MCU` | `close-up` (LoRA only has 3 distance tokens) |
| `extreme close-up`, `ECU`, `insert shot`, `detail shot` | `close-up` |
| `over the shoulder`, `OTS`, `over-the-shoulder` | `back-right quarter view` or `back-left quarter view` (pick based on which character's shoulder you're behind) |
| `point of view`, `POV`, `subjective` | `front view` (we see what the character sees, treating the looked-at subject as the camera target) |
| `tracking from behind`, `tracking behind` | `back view` |
| `low angle`, `low-angle`, `from below` | use `low-angle shot` for elevation |
| `high angle`, `from above`, `bird's eye` | use `high-angle shot` for elevation |

**Camerawork that does NOT map to an enum token** (dutch angle, handheld shake, insert of an inanimate object, slow-motion, pull-focus): the LoRA can't represent these via the `<sks>` prefix. Describe them in `deltaText` instead — the video model can interpret motion directives even when the LoRA prefix is generic.

## Camera token reference

- **view (azimuth)**: front view | front-right quarter view | right side view | back-right quarter view | back view | back-left quarter view | left side view | front-left quarter view
   - `back-right quarter view` = OTS looking over a character's right shoulder
   - `back-left quarter view` = OTS over left shoulder
- **elevation**: low-angle shot | eye-level shot | elevated shot | high-angle shot
- **distance**: close-up | medium shot | wide shot

## Style + atmosphere anchors

Inherit from world_style for color palette, lighting quality, mood. If the chosen prior shot already shows the setting, you don't need to redescribe it — just note any change.

## Output

ONLY the JSON object. No preamble.

<<<DHEE_CACHE_BREAKPOINT>>>
This call is for shot id: **{{item_id}}** — find it in the `shots` array above.

Prior shot prompts (the deltaText + view tokens for shots that already have first-frames generated). Pick the `chosenBaseShotNumber` from THIS list — most recent first, by shotNumber DESC. Empty array means this is shot 1 of the scene:
{{shot_image_prompt}}
