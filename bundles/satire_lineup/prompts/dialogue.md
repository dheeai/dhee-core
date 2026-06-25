You produce the VOICE SCRIPT for ONE character of a satirical lineup reel. The text is spoken by Higgs Audio v3 TTS and lip-synced. You keep the spoken WORDS exactly as written, but you ANNOTATE them with Higgs control tags so the delivery carries the character's emotion and performance.

Cast (find the character whose id is {{item_id}} — use its `line`, `emotion` and `sfx`):
{{cast}}

## Rule 1 — spoken words are VERBATIM
Take that character's `line` and keep every spoken word exactly as written, in its original native script (e.g. Devanagari). Do NOT translate, transliterate/romanize, paraphrase, add or drop spoken words, or re-spell them. You may ONLY insert Higgs control tags around/between the existing words, and convert written laughter into a laughter tag (see Rule 4).

## Rule 2 — Higgs control tags you may use
- Emotion (place ONE at the very START): `<|emotion:VALUE|>` where VALUE is the closest of:
  elation, amusement, enthusiasm, determination, pride, contentment, affection, relief, contemplation, confusion, surprise, awe, longing, arousal, anger, fear, disgust, bitterness, sadness, shame, helplessness.
- Prosody (speed/pitch/expressive go at the START, right after emotion; pauses go INLINE where the beat occurs):
  `<|prosody:speed_slow|>` `<|prosody:speed_fast|>` `<|prosody:pitch_low|>` `<|prosody:pitch_high|>` `<|prosody:expressive_high|>` `<|prosody:expressive_low|>` `<|prosody:pause|>` (~0.5s) `<|prosody:long_pause|>` (~1s).
- Style (at the START, only if it truly fits): `<|style:shouting|>` `<|style:whispering|>` `<|style:singing|>`.
- SFX (INLINE, immediately before the onomatopoeia): `<|sfx:laughter|>` `<|sfx:sigh|>` `<|sfx:cough|>` etc.

## Rule 3 — map this character's `emotion` to the tags
Read the character's `emotion` field and choose the best-fitting emotion tag plus optional prosody/style. Examples of intent (adapt to THIS character):
- arrogant / boastful → `<|emotion:pride|>`
- cold / predatory / menacing → `<|emotion:bitterness|>` + `<|prosody:expressive_low|>`
- manic / hysterical TV energy → `<|emotion:amusement|>` + `<|prosody:expressive_high|>` + `<|prosody:speed_fast|>`
- smug / greedy / untouchable → `<|emotion:contentment|>` or `<|emotion:amusement|>`
- resolute / heroic / defiant → `<|emotion:determination|>`

## Rule 3b — PACING IS CRITICAL (keep it FAST)
This is a fast social reel — slow delivery kills it. Therefore:
- ALWAYS start the line with `<|prosody:speed_fast|>` (after the emotion tag). Every character is delivered briskly.
- NEVER use `<|prosody:speed_slow|>` or `<|prosody:speed_very_slow|>`.
- A whole line should land in roughly 3–6 seconds of speech. Do not stretch it.

## Rule 4 — strip the ellipses, minimal pauses, one short laugh
- DELETE every ellipsis "…" and "..." from the line entirely — do NOT keep them as text and do NOT convert them to pause tags. Replace each with a single space so the words flow. (Higgs pauses on literal "…", which drags the line.)
- Pauses: prefer NONE. At most ONE `<|prosody:pause|>` at the single most important beat (just before the punchline word). NEVER use `<|prosody:long_pause|>`.
- Laughter: if the line has written laughter, put ONE `<|sfx:laughter|>` before a SHORT laugh onomatopoeia (e.g. "हाहाहा"); do not repeat it even if the script doubled it.
- SFX: use ONLY these exact values — laughter, cough, crying, screaming, burping, humming, sigh, sniff, sneeze. If the character's `sfx` is anything else (e.g. a snort, thunder, applause), DO NOT emit an sfx tag for it.

## Output
Output ONLY this JSON. `line` = the words verbatim, wrapped with the Higgs tags. `speaker` = "{{item_id}}".
{ "speaker": "{{item_id}}", "line": "<tagged verbatim line>" }

Example shape (illustrative, not your content):
{ "speaker": "x", "line": "<|emotion:pride|><|prosody:expressive_high|>मैं सबसे बड़ा हूँ<|prosody:pause|> इसलिए<|sfx:laughter|>हाहाहाहा" }
