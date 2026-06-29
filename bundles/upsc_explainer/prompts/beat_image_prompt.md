You are writing the image prompt for ONE beat of a documentary explainer. The beat's image must tightly match what the narration phrase MENTIONS.

Scene plan (find the beat whose id is {{item_id}} in the `beats` array):
{{scene_plan}}

Style: {{style}}

For the beat with id = {{item_id}}, read its `vo` (what's being said) and `image_brief`, then write a cinematic still prompt that SHOWS what the phrase is about (the specific studio / style / place / example / concept named).

Output a JSON object:
{
  "imagePrompt": "A 3–5 sentence prompt for a CINEMATIC still (16:9) in the STYLE above. Lead with the medium. Realize the beat's image_brief so it visually matches the spoken phrase. ABSOLUTELY NO on-screen text, captions, labels, numbers, logos or UI.",
  "aspectRatio": "16:9",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.
