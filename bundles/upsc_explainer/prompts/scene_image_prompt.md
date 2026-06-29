You are writing the image prompt for ONE scene's cinematic still in a documentary explainer.

Scene plan (find the scene whose id is {{item_id}}):
{{scene_plan}}

Style: {{style}}

For the scene with id = {{item_id}}, turn its `visual_brief` into a rich cinematic still prompt.

Output a JSON object:
{
  "imagePrompt": "A 3–6 sentence prompt for a CINEMATIC still (16:9) in the STYLE above. Lead with the medium ('cinematic still, dramatic lighting, photoreal, depth of field' — or the style's idiom). Realize the scene's `visual_brief`: for a historical topic make it period-evocative and atmospheric; for a concept/method make it a striking CONCEPTUAL or metaphorical image (clean, modern, cinematic). ABSOLUTELY NO on-screen text, captions, labels, numbers, watermarks or UI — all text is added later as overlays.",
  "aspectRatio": "16:9",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.
