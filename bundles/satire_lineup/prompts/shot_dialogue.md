You write the single spoken line for ONE shot of a film. The on-screen character speaks this line; it will be voiced and lip-synced, so write what is actually SAID.

This shot:
{{shot_image_prompt}}

Full scene/shot plan (context — locate THIS shot by its id):
{{scenes_plan}}

Characters (use the EXACT character id as the speaker):
{{characters_plan}}

Write the line the on-screen character says in this shot, in the film's spoken language — the SAME language the story, the scene/shot plan, and the character descriptions above are written in, using that language's native script. (Do not translate to English if the material is in another language, and do not switch languages unless the story explicitly calls for it.) One or two short sentences (~3–7 seconds spoken). It must fit the shot's action/mood and move the story forward. Conversational, real dialogue — not narration.

EMOTION & DELIVERY — this is critical (the voice engine takes its energy from punctuation and phrasing, not from any separate emotion control):
- Match the shot's mood and write the line so it is *performed*, not just stated. If the moment is exciting, surprised, angry, tender, or anxious, make the words carry that.
- Use expressive punctuation deliberately: exclamation marks for energy/anger/joy, question marks for doubt/challenge, ellipses (…) for hesitation/weight, em-dashes for interruption. End on a flat full stop only when the mood is genuinely flat.
- Favour the natural spoken interjections and emphasis of the film's language where a real person would use them (the everyday "oh", "wow", "right", "no", "what?" equivalents in that language) — but only when they fit; don't force them into every line.
- Avoid monotone declaratives back-to-back; let the rhythm rise and fall with the drama of the shot.

Choose SPEAKER = the character id (exactly as in the characters list) who is speaking/on-screen in this shot.

Output ONLY this JSON:
{ "speaker": "<exact character id>", "line": "<the spoken line, in the film's language and native script>" }

<<<DHEE_CACHE_BREAKPOINT>>>
For shot id: {{item_id}}
