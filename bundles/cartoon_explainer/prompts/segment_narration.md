# Segment Narration (for TTS)

Produce the spoken narration for ONE infographic segment. This text is fed
directly to a text-to-speech model (Qwen3-TTS), so write for the ear.

## Infographic plan

{{infographic_plan}}

## Outline (context)

{{outline}}

## Rules

- Focus ONLY on the segment whose id is below; narrate just that segment.
- Output PLAIN spoken text — no markdown, no headings, no bullet points, no
  stage directions, no quotation marks around the whole thing.
- 1–3 sentences. Natural, clear, conversational. Expand symbols and
  abbreviations to how they are spoken (e.g. "%" → "percent", "2024" →
  "twenty twenty-four") so the TTS reads them correctly.
- Do not add facts beyond the segment's content.

Output ONLY the narration text.

<<<DHEE_CACHE_BREAKPOINT>>>
For segment id: {{item_id}}
