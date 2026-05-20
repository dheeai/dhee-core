# Reference Extraction — Turn 2 of shot_image_prompt

You wrote a cinematic prose paragraph in the previous turn. Now read your own
prose and identify which **reference images** the renderer will need to
produce this shot. Output a structured JSON list of refs only — do NOT
rewrite the prose.

## Inputs in this turn's user message

- **`prose`** — the imagePrompt paragraph you just authored. Treat it as
  authoritative: every character / setting / object visible in the image
  must be named in the prose, and conversely the prose must not name
  anything that's off-screen.
- **`reference_menu`** — a JSON array of every `character_image` and
  `setting_image` reference that already exists in the project. Each
  entry has `{refId, type, label, description}`. **Prefer existing refs
  over inventing new ones** — same name, same description ⇒ same ref.
- **`shot_brief`** — the original shot brief (focus, perspective,
  cameraWork) so you can resolve OTS framing.

## Output schema

```json
{
  "references": [
    { "refId": "...", "type": "character|setting|object", "imageNumber": 1..4, "status": "existing|new", "side": "A|B" (optional), "newRefDescription": "..." (only when status='new') }
  ]
}
```

Wrap in a `{ "references": [...] }` object. No prose, no markdown, no
explanation.

## Slot binding rules (Klein 4-slot model)

The Klein image-edit workflow accepts at most 4 reference slots per render:

- **`imageNumber: 1`** is reserved for the setting / canvas. Always include
  exactly one setting ref. If the prose is interior, pick a setting ref
  whose description matches the interior; if exterior, pick the exterior.
  Never put a character in slot 1.
- **`imageNumber: 2..4`** are characters / objects in order of visual
  prominence in the prose. The most foreground / most-described character
  goes in slot 2, the second most prominent in slot 3, and so on.
- **Maximum 4 total references.** If the prose names more than 3 distinct
  characters, drop the least essential to fit the cap — the prose can
  still describe a crowd, but only 3 character refs can be slotted.
- **No duplicates.** Each refId appears once; if the prose names the same
  character twice, that's one entry.

## Existing vs new

For each ref the prose names:

1. **Try to match against `reference_menu` first.** Same character name or
   same setting label ⇒ `status: 'existing'`, use the menu's `refId`.
2. **Only mark `status: 'new'` if no existing ref fits.** New refs MUST
   include `newRefDescription` — a 1-2 sentence visual description suitable
   for the downstream image generator (clothing, build, hair, distinguishing
   marks for characters; lighting, time of day, key elements for settings).
   The description goes into the project's `character` / `setting` artifact
   collection and the renderer uses it to produce the missing ref image
   before this shot proceeds.
3. **`refId` format** for new refs: `<type>:<snake_case_name>` — e.g.
   `character_image:pawn_broker`, `setting_image:alley_behind_pawn_shop`.

## Side A / Side B (over-the-shoulder framing only)

When the shot brief or the prose indicates an OTS / dialogue framing —
the camera is shooting past one character toward another:

- Mark the **in-frame subject** (face visible, the one being looked at) as
  `side: 'A'`.
- Mark the **OTS silhouette** (back of head / shoulder in foreground) as
  `side: 'B'`.

For non-OTS shots (everyone facing camera, single-character closeups,
crowd shots, etc.), omit the `side` field entirely. Don't invent a side
when the framing isn't reverse-shot.

The next shot in a dialogue exchange will likely have the sides flipped:
shot N puts Ruby `side: 'A'` + Angel `side: 'B'`; the reverse shot N+1
puts Angel `side: 'A'` + Ruby `side: 'B'`. That mirroring is a
consequence of the prose framing, not something you decide.

## Examples

### Example 1: Single-character closeup

Prose: *"Ruby leans against the bus station's concrete pillar, her eyes scanning the platform, hair catching the harsh midday sun…"*

Menu includes `character_image:ruby` (Ruby — red hair, leather jacket) and `setting_image:bus_station_morning` (Bus station, harsh overhead sun).

Output:
```json
{
  "references": [
    { "refId": "setting_image:bus_station_morning", "type": "setting", "imageNumber": 1, "status": "existing" },
    { "refId": "character_image:ruby", "type": "character", "imageNumber": 2, "status": "existing" }
  ]
}
```

### Example 2: OTS dialogue with a new character

Prose: *"In the dim pawn shop, Ruby stands at the counter facing the owner across stacks of merchandise. The shot favors Ruby in sharp focus; the owner is a heavyset man in his fifties, bald, gold tooth glinting, framed as a soft silhouette in the foreground left…"*

Menu includes `character_image:ruby` and `setting_image:pawn_shop_interior`, but no owner ref.

Output:
```json
{
  "references": [
    { "refId": "setting_image:pawn_shop_interior", "type": "setting", "imageNumber": 1, "status": "existing" },
    { "refId": "character_image:ruby", "type": "character", "imageNumber": 2, "status": "existing", "side": "A" },
    { "refId": "character_image:pawn_shop_owner", "type": "character", "imageNumber": 3, "status": "new", "side": "B", "newRefDescription": "Heavyset man, late 50s, bald with a gold tooth, ink-stained apron over a worn flannel shirt." }
  ]
}
```

### Example 3: Reverse shot

Prose: *"Now from over Ruby's shoulder, the owner's face fills the frame, sweat beading on his brow…"*

Same menu plus the now-existing `character_image:pawn_shop_owner` from the prior shot.

Output:
```json
{
  "references": [
    { "refId": "setting_image:pawn_shop_interior", "type": "setting", "imageNumber": 1, "status": "existing" },
    { "refId": "character_image:pawn_shop_owner", "type": "character", "imageNumber": 2, "status": "existing", "side": "A" },
    { "refId": "character_image:ruby", "type": "character", "imageNumber": 3, "status": "existing", "side": "B" }
  ]
}
```

Note: shot 3's OTS perfectly mirrors shot 2 — same two refs, sides flipped, same setting.

## Hard rules

- ALWAYS include a setting ref at slot 1.
- NEVER exceed 4 references total.
- NEVER include a character not named in the prose.
- NEVER drop a character the prose explicitly puts in the frame.
- `imageNumber` values must be unique within the array (no two refs share a slot).
- Output is JSON only, no commentary.
