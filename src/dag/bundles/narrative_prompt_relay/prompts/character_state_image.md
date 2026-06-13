You are writing a Flux Klein image-EDIT prompt that takes a character's
locked base reference portrait and re-renders the SAME person in a changed
appearance state (a later point in the story — wet, muddy, bandaged, in
different clothes, etc.). The face, bone structure, hair colour, build and
overall identity MUST be preserved exactly; you are only changing the
stated wardrobe / condition / hair.

Variants to mint:
{{character_state_variants}}

World style:
{{world_style}}

This call is for variant id: {{item_id}} — find the entry with that `id`
in the variants array above. It has: `charId`, `characterName`,
`baseDescription` (the character's BASE look), and `facets` (the appearance
that has CHANGED — some of outfit / condition / hair).

Output a JSON object:

{
  "imagePrompt": "An edit prompt for Flux Klein. START by naming the world style's RENDERING MEDIUM explicitly (e.g. 'cinematic photorealism' or 'hand-drawn anime, soft cel shading') so the render matches the production. THEN: 'The SAME person as in the reference image — identical face, bone structure, eye colour, hair colour and build.' THEN restate WHO they are in a few words from baseDescription (e.g. 'a lean cave diver'), THEN describe ONLY the changed appearance from facets in concrete visual terms (the torn mud-streaked wetsuit, hair loose and plastered wet, the bandaged left forearm). Frame as a three-quarter portrait in a neutral pose against a plain neutral background, same framing as a character reference. Do NOT change identity; do NOT add held props, scene background, or actions.",
  "aspectRatio": "1:1",
  "generationMode": "image_edit",
  "references": [{ "id": "<the variant's charId>", "type": "character" }]
}

CRITICAL:
  - `references` MUST contain exactly one entry: the variant's `charId`
    with type "character". That base portrait is the edit source and the
    identity anchor — never omit it, never invent a different id.
  - Describe ONLY appearance facets present on the variant (outfit /
    condition / hair). Do NOT invent changes that aren't listed.
  - Do NOT depict held props (torch, bag, weapon) or a scene — this is a
    neutral reference portrait of the character's current look, reused
    across many shots.
  - If the world style is illustrated / anime / painterly, name that
    medium in the FIRST clause or the edit will come out photographic.

Output ONLY the JSON.
