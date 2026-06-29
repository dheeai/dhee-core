You are parsing a SCRIPT for a short satirical "lineup" reel. The script defines a set of characters; each character appears once, in its own setting, and speaks one line to camera.

Your job: read the script and emit ONE entry per character. The NUMBER of characters comes from the script — do not add, merge, drop or invent characters, and do not cap the count.

Script:
{{script_input}}

For EACH character in the script, produce:
- `id` — lowercase_snake_case, derived from the character's name (e.g. "owl_anchor", "fox_clerk", "robot_guide"). Unique.
- `name` — display name.
- `description` — 120–200 word PURE VISUAL identity of the actor: the anthropomorphic species/form, build, head/face, distinctive features (horns, beak, antennae, eyes), clothing (specific garments, colours, textures), posture. This is a stable reference so the SAME actor could be re-rendered. NO setting, NO emotion, NO dialogue here.
- `setting` — 1–3 sentences describing THIS character's OWN location/background and mood (e.g. a TV newsroom with LED breaking-news walls; a wood-panelled courtroom; a rural construction site office). Each character has its own setting.
- `speaker` — MUST equal this character's `id`.
- `line` — the EXACT line this character speaks, copied **VERBATIM** from the script, in its original native script (e.g. Devanagari for Hindi). DO NOT translate, transliterate/romanize, paraphrase, shorten, censor or "clean up". Preserve every word, including any laughter written in the script (e.g. "हाहाहाहा"). This is the single most important field — fidelity is critical because it is voiced and lip-synced.
- `emotion` — the performance/delivery for the line (the character's mood as the script describes it).
- `sfx` — any sound cues the script gives for this character (optional; "" if none).

Preserve the ORDER of characters as they appear in the script.

Output ONLY this JSON:
{
  "characters": [
    { "id": "...", "name": "...", "description": "...", "setting": "...", "speaker": "...", "line": "...", "emotion": "...", "sfx": "..." }
  ]
}
