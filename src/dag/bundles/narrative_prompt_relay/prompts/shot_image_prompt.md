You are writing a Flux Klein image-edit prompt for the FIRST FRAME of a single shot.

Shot data:
{{scenes_plan}}

World style:
{{world_style}}

Available character references (only those listed are available for
visual conditioning):
{{characters_plan}}

Available setting references:
{{settings_plan}}

The first frame is what the audience sees when this shot begins.
Compose it as one held cinematic frame.

Output a JSON object:

{
  "imagePrompt": "A 4–8 sentence imagePrompt for Flux Klein. START by stating the world style's RENDERING MEDIUM explicitly — the art style / how it is drawn (e.g. 'luminous storybook anime, soft hand-drawn linework, soft cel shading, painterly' — or 'cinematic photorealism' if that is the world style) plus the dominant palette. THEN the INLINE VISUAL HOOK in parentheses naming the main character's defining feature (e.g. '(red braid, freckles)') OR for setting-only shots a setting anchor. Describe composition, what's in frame, action mid-progress (this is the FIRST frame so the action is JUST starting), lighting, mood. Match shot.cameraWork for framing/lens, and world_style for lighting quality.",
  "aspectRatio": "16:9",
  "generationMode": "image_edit",
  "references": [array of {id: <character or setting id>, type: 'character' | 'setting'} in priority order — max 4 total. The first entry is the BASE; characters and settings stack on top.]
}

CRITICAL — references must NOT be empty for image_edit. The image-edit
workflow is reference-conditioned: it CANNOT render without at least one
reference image, so every image_edit shot MUST list ≥1 entry in
references[]. Rules:
  - Only use ids that appear in the Available character references /
    Available setting references above. NEVER invent an id, and NEVER
    cite a character who is not in the available list (if the shot
    features someone not listed, drop them from references and rely on
    the imagePrompt text for that figure).
  - If no listed character is in frame, still include the shot's SETTING
    as the base reference — the setting is always available and anchors
    the era/palette.
  - Only if NO character AND NO setting reference applies at all, set
    "generationMode": "text_to_image" and leave references as []. Do not
    emit image_edit with an empty references array.

CRITICAL: the image model defaults to PHOTOREALISM and ignores mood/lighting cues alone. If the world style is illustrated / anime / painterly / hand-drawn, the imagePrompt MUST name that rendering medium explicitly in its FIRST clause — otherwise the render comes out as a photograph.

Output ONLY the JSON.

<<<DHEE_CACHE_BREAKPOINT>>>
This call is for shot id: {{item_id}} — find it in the shots array above and write the first-frame prompt for ONLY that shot.

Character continuity state at THIS shot (folded from the continuity plan — this is AUTHORITATIVE for the character's current appearance and OVERRIDES the neutral look in the cast breakdown above):
{{character_state}}

If a character listed here has a non-base `outfit` / `condition` / `hair` / `posture` / `props`, your imagePrompt MUST reflect that CURRENT state — e.g. the torn mud-streaked jacket, the soaked hair, the bleeding arm, the lit torch in hand — not their clean introduction look. The reference image still anchors their identity (face, build), so describe the changed state in the prompt text. If the list is empty, use the cast breakdown defaults as-is.
