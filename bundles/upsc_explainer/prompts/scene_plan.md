You are storyboarding a ~{{duration}}-second cinematic explainer for {{audience}} in this style: {{style}}. Turn the outline into a SCENE PLAN with fine-grained BEATS.

Outline:
{{outline}}


## Coverage
Cover the outline's FULL substance across the scenes/beats — if the source is a long researched project, span ALL its major sections (use more scenes/beats), weighted by importance; do not drop sections or stop after the intro.

## Scenes (the arc + on-screen graphics)
Produce AS MANY scenes as the content and the {{duration}} require — do NOT cap the number. Each scene is a CHAPTER covering one major section / sub-topic. As a rough guide, about one scene per ~30–90 seconds of video (≈4–6 scenes for 60s, ≈8–14 for 5 min, ≈25–45 for 20 min, and proportionally more for an hour) — but let the SOURCE's structure and the duration decide, never a fixed number. ALWAYS open with a "hook" scene and end with a "revision/recap" scene; adapt the middle to the topic (HISTORICAL → causes/events/consequences; CONCEPT/METHOD → why/how/tradeoffs/examples; a RESEARCHED PROJECT → one scene per major section). Each scene has:
- `role`, optional `title`
- `keywords`: 1–4 SHORT on-screen terms for the scene
- `timeline` (on the ONE scene with a sequence): { "years": [ years OR ordered step labels ] }; omit if no sequence
- `card` (ONLY the "revision" scene): { "title": "Remember", "bullets": [4–5 points] }

## Beats (the synced visual + voice units — THIS IS THE KEY PART)
Break the narration into a flat, ordered list of BEATS. Each beat is ONE short spoken phrase shown over ONE image. The image MUST match what the phrase MENTIONS — when the narrator names a specific thing (a studio, an art style, a place, an example, a person), that beat's image shows THAT thing. The image swaps exactly when the narration moves to the next beat, so the mention and the visual stay in sync ("zing").
- Aim for ~2.6 spoken words/second; each beat `vo` is ~2–7 seconds (roughly 6–18 words). A {{duration}}s video has roughly {{duration}}/4 to {{duration}}/3 beats — produce THAT many, however large (a 20-minute video has hundreds of beats; do not cap or summarise to fewer).
- Each beat: `id` (unique snake_case), `scene` (the id of the scene it belongs to — beats are grouped under scenes in order), `vo` (the exact phrase), `image_brief` (tightly matched to the vo).
- Cover every scene with beats, in reading order. The concatenation of all beats' `vo` IS the full narration.

## Variety
- `ltx_beat_ids`: the most dynamic beats to animate as motion video — keep SPARSE, roughly ONE per 1–2 minutes of video (LTX is slow/expensive); the rest are Ken Burns stills.
- ASYMMETRY: for a few beats where comparing/contrasting two things helps, set `layout` to "split_v" (two asymmetric vertical panels) or "split_diag" (diagonal slash) and provide BOTH `image_brief` and `image_brief_b` (the two visuals). Use sparingly for punch (a couple per video). Default layout "full". ALSO list every split beat's id in `split_beat_ids`.

Output JSON:
{ "title":"...", "ltx_beat_ids":["..."],
  "scenes":[ {"id","role","title","keywords":[...],"timeline":{...}?,"card":{...}?}, ... ],
  "split_beat_ids":["<ids of beats whose layout is split_v/split_diag>"],
  "beats":[ {"id","scene","vo","image_brief","layout"?,"image_brief_b"?}, ... ] }
Output ONLY the JSON.
