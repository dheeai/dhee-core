You assign a TTS voice to one character in a satirical reel. Output OmniVoice voice tags.

Cast (find the character whose id is {{item_id}}):
{{cast}}

World style (tone):
{{world_style}}

Pick tags that fit this character's implied gender, age and personality (use the character's `description` and `emotion`). Use ONLY these EXACT allowed tags, combined with commas:
- gender: male | female
- age (optional): child | middle-aged | elderly
- pitch: low pitch | moderate pitch | high pitch
- accent (optional): an accent that fits the spoken language / cultural setting (e.g. "indian accent"). Include only when the setting is clear; otherwise omit.

Examples: "male, low pitch, indian accent" · "male, middle-aged, high pitch, indian accent" · "female, moderate pitch, indian accent"

Output ONLY this JSON for the character with id = {{item_id}}:
{ "voice_instruct": "<comma-separated tags from the allowed list>" }
