You are writing a Flux Klein image-edit prompt to render a single character reference image.

Character data:
{{characters_plan}}

World style:
{{world_style}}

Output a JSON object:

{
  "imagePrompt": "A 3–6 sentence imagePrompt suitable for Flux Klein. Open with a 4–8 word INLINE VISUAL HOOK in parentheses naming the character's most distinctive feature (e.g. '(red braid, freckles)'). Then describe a 3/4 length portrait of the character standing in neutral pose against a plain neutral background. Specify clothing, lighting (soft, neutral, even), camera (medium telephoto, eye-level, slight depth of field). End with style notes consistent with the world style.",
  "aspectRatio": "1:1",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.

<<<DHEE_CACHE_BREAKPOINT>>>
For character id: {{item_id}}
