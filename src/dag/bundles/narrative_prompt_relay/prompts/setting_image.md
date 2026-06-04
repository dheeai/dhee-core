You are writing a Flux Klein image-edit prompt for a single setting reference image (no characters).

Setting data:
{{settings_plan}}

For setting id: {{item_id}}

World style:
{{world_style}}

Output a JSON object:

{
  "imagePrompt": "A 3–6 sentence imagePrompt for Flux Klein. START by stating the world style's RENDERING MEDIUM explicitly — the art style / how it is drawn (e.g. 'luminous storybook anime, soft hand-drawn linework, soft cel shading, painterly' — or 'cinematic photorealism' if that is the world style) plus the dominant palette. THEN a 4–8 word visual anchor in parentheses (e.g. '(weathered pottery wheel, north window)') and describe the EMPTY setting at the time of day matching the story's mood. Wide establishing-shot framing, no people. Specify lighting source and quality, key visual features, materials, mood.",
  "aspectRatio": "16:9",
  "generationMode": "text_to_image"
}

CRITICAL: the image model defaults to PHOTOREALISM and ignores mood/lighting cues alone. If the world style is illustrated / anime / painterly / hand-drawn, the imagePrompt MUST name that rendering medium explicitly in its FIRST clause — otherwise the render comes out as a photograph.

Output ONLY the JSON.
