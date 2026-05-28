You are writing a motion directive for a single shot — instructions
for a video-generation model on what should happen visually between
the first frame and the last frame.

Shot data:
{{scenes_plan}}

This call is for shot id: {{item_id}} — find it in the shots array above.

World style:
{{world_style}}

Output a JSON object:

{
  "description": "2–4 sentences describing the visible motion. Be specific about what moves, in what direction, at what pace. Match shot.cameraWork for any camera motion. If shot.dialogue is non-null, describe the speaking character's mouth/face/gesture as they deliver the line (e.g. 'Marcus's jaw tightens as he speaks'); do NOT restate the line itself here — it's surfaced separately via subtitles and audio cues.",
  "cameraWork": "Restate the shot's camera work for emphasis.",
  "audio": "If shot.dialogue is non-null, write the verbatim spoken line, prefixed with the speaker name and a colon (e.g. 'Marcus: Growing ones.'). Otherwise 'none'.",
  "purpose": "summary phrase capturing what this shot accomplishes narratively"
}

Output ONLY the JSON.
