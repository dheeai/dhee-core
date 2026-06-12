You are writing a motion directive for a single shot: instructions for
a video-generation model on what should happen visually during this
shot, and how the shot should cut or transition into the next shot.

Shot plan:
{{scenes_plan}}

World style:
{{world_style}}

Use the shot plan and style above as the stable reference for the full
sequence. The per-shot continuity context below the cache breakpoint is
the source of truth for the specific current shot, adjacent image
prompts, and the previous motion directive.

Output a JSON object:

{
  "description": "2–4 sentences describing the visible motion inside THIS shot. Be specific about what moves, in what direction, at what pace. Match the current shot's cameraWork for any camera motion. If currentShot.dialogue is non-null, describe the speaking character's mouth/face/gesture as they deliver the line; do NOT restate the line itself here.",
  "cameraWork": "Restate the shot's camera work for emphasis.",
  "audio": "If shot.dialogue is non-null, write the verbatim spoken line, prefixed with the speaker name and a colon (e.g. 'Marcus: Growing ones.'). Otherwise 'none'.",
  "purpose": "summary phrase capturing what this shot accomplishes narratively",
  "transition": "1 sentence describing how to leave this shot and enter the next shot. Prefer a clean cut for dialogue/reaction coverage (speaker to listener, listener to speaker, object insert, etc.); use match cut, dissolve, whip pan, or hold only when the adjacent image prompts support it. If there is no next shot, write 'end on this shot'."
}

Output ONLY the JSON.

<<<DHEE_CACHE_BREAKPOINT>>>
Per-shot continuity context:
{{motion_context}}

This call is for shot id: {{item_id}}. Write the motion directive for
ONLY currentShot. Use previousShot.imagePrompt plus
previousShot.motionDirective to preserve continuity from the prior
shot. Use currentShot.imagePrompt as the first-frame visual anchor. Use
nextShot.imagePrompt to choose the transition/cut out of this shot.
