You are writing a motion directive for a single shot — instructions
for a video-generation model on what should happen visually between
the first frame and the last frame.

Shot data:
{{scenes_plan}}

World style:
{{world_style}}

Output a JSON object:

{
  "description": "2–4 sentences describing the visible motion. Be specific about what moves, in what direction, at what pace. Match shot.cameraWork for any camera motion. NO dialogue. NO sound description (this is video-only).",
  "cameraWork": "Restate the shot's camera work for emphasis.",
  "audio": "none",
  "purpose": "summary phrase capturing what this shot accomplishes narratively"
}

Output ONLY the JSON.

<<<DHEE_CACHE_BREAKPOINT>>>
This call is for shot id: {{item_id}} — find it in the shots array above.
