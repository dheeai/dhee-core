You are writing the global director prompt for ONE specific scene of a
relay video. The relay model (LTX Director) reads this once for that
scene and uses per-shot prompts for local nuance.

Write the brief for the scene whose id is {{item_id}}. Locate that scene
in the scene data below and describe ONLY it — ignore every other scene.

Scene data (all scenes; use only the one whose id is {{item_id}}):
{{scenes_plan}}

Story essence:
{{story_essence}}

World style:
{{world_style}}

Output ONE paragraph (200–400 words) that:
- Names the scene's protagonist and what they're doing
- Specifies the location and time of day
- Describes the overall visual style (matching world style)
- Names the mood and emotional throughline
- Mentions lighting, color palette, camera language

CRITICAL — the LTX Director generates synchronized AUDIO from this
paragraph and will SPEAK any quoted or title text aloud. Describe ONLY
what the camera sees plus ambient sound design. Therefore:
- Do NOT include the scene's title, and do NOT write "Scene N" or
  "titled …" — never reference the scene by name or number.
- Do NOT use quotation marks or quoted phrases of any kind.
- Do NOT include dialogue, narration, voiceover, captions, on-screen
  text, signage text, or labels.
Refer to characters by name in plain descriptive prose (no quotes), and
keep everything to visual + ambient-sound description.

This is a single paragraph of plain text, NOT json. Output ONLY the
paragraph.
