You are writing an image prompt for a single EMPTY setting plate — the background a character will be composited into. NO characters, NO people, NO animals in this image.

Cast (find the character whose id is {{item_id}} and use its `setting`):
{{cast}}

World style (rendering medium + palette + lighting):
{{world_style}}

Write the empty-setting plate for the character with id = {{item_id}} ONLY, based on that character's `setting` field.

Output a JSON object:
{
  "imagePrompt": "A 3–5 sentence prompt. START by naming the rendering medium from the world style. Describe the EMPTY location from the character's setting (the room/environment, key props, architecture) framed as a vertical 9:16 background plate with clear space where a single figure will stand or sit, facing the implied camera. Cinematic lighting and mood per the world style. ABSOLUTELY NO people, animals or characters of any kind. No readable text or logos.",
  "aspectRatio": "9:16",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.
