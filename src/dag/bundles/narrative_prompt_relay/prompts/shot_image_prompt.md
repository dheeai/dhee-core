You are writing a Flux Klein image-edit prompt for the FIRST FRAME of a single shot.

Shot data:
{{scenes_plan}}

This call is for shot id: {{item_id}} — find it in the shots array above.

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

CRITICAL: the image model defaults to PHOTOREALISM and ignores mood/lighting cues alone. If the world style is illustrated / anime / painterly / hand-drawn, the imagePrompt MUST name that rendering medium explicitly in its FIRST clause — otherwise the render comes out as a photograph.

Output ONLY the JSON.
