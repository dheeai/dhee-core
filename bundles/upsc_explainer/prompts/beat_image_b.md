You are writing the image prompt for the SECOND visual of a SPLIT (asymmetric) beat — it will sit beside the beat's primary image in a vertical panel or diagonal slash.

Scene plan (find the beat whose id is {{item_id}} in the `beats` array):
{{scene_plan}}

Style: {{style}}

For the beat with id = {{item_id}}, use its `image_brief_b` (the second/contrasting visual). Write a cinematic still prompt for it, in the same STYLE, that pairs well beside the primary image (a contrast or complement to what the beat compares).

Output a JSON object:
{
  "imagePrompt": "A 3–5 sentence prompt for a CINEMATIC still (16:9) in the STYLE above, realizing image_brief_b. NO on-screen text, captions, labels, logos or UI.",
  "aspectRatio": "16:9",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.
