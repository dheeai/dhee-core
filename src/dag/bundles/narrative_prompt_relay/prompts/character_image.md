You are writing a Flux Klein image-edit prompt to render a single character reference image.

Character data:
{{characters_plan}}

For character id: {{item_id}}

World style:
{{world_style}}

Output a JSON object:

{
  "imagePrompt": "A 3–6 sentence imagePrompt suitable for Flux Klein. START by stating the world style's RENDERING MEDIUM explicitly — the art style / how it is drawn (e.g. 'luminous storybook anime, soft hand-drawn linework, soft cel shading, painterly' — or 'cinematic photorealism' if that is the world style) plus the dominant palette. THEN a 4–8 word INLINE VISUAL HOOK in parentheses naming the character's most distinctive feature (e.g. '(red braid, freckles)'), and describe a 3/4 length portrait of the character standing in neutral pose against a plain neutral background. Specify clothing, lighting (soft, neutral, even), camera (medium telephoto, eye-level, slight depth of field).",
  "aspectRatio": "1:1",
  "generationMode": "text_to_image"
}

CRITICAL: the image model defaults to PHOTOREALISM and ignores mood/lighting cues alone. If the world style is illustrated / anime / painterly / hand-drawn, the imagePrompt MUST name that rendering medium explicitly in its FIRST clause — otherwise the render comes out as a photograph.

Output ONLY the JSON.
