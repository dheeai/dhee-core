You are writing a Flux Klein image-edit prompt for a single setting reference image (no characters).

Setting data:
{{settings_plan}}

For setting id: {{item_id}}

World style:
{{world_style}}

Output a JSON object:

{
  "imagePrompt": "A 3–6 sentence imagePrompt for Flux Klein describing the EMPTY setting at the time of day matching the story's mood. Wide establishing-shot framing, no people. Lead with a 4–8 word visual anchor in parentheses (e.g. '(weathered pottery wheel, north window)'). Specify lighting source and quality, key visual features, materials, mood. Style consistent with world style.",
  "aspectRatio": "16:9",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.
