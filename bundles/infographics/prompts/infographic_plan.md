# Infographic Plan

Turn the outline into a structured plan the pipeline can render. Each segment
becomes ONE infographic still (Ideogram 4) plus ONE narration track (Qwen3-TTS).
Infographic panels are pure data design — NO people, faces, or talking heads.

## Outline

{{outline}}

## Style

Visual style: {{style}}. Aspect ratio: {{aspect}}.

## Output

Return ONLY JSON conforming to the schema. For each segment provide:

- `id` — short kebab/snake id, unique and stable (e.g. "intro", "growth_2024").
- `title` — the segment's on-screen headline (a few words).
- `key_points` — 1–4 short strings: the facts/labels that must appear in the
  infographic. Use only what the outline/brief supports.
- `visual_prompt` — 2–4 sentences describing the infographic panel to draw:
  layout, chart/diagram type, key labels and numbers, colour treatment, and the
  `{{style}}` look. Ideogram 4 renders text well, so name the exact words/labels
  that should appear.
- `narration` — 1–3 sentences of spoken narration for this segment, in natural
  spoken English (this is read aloud, so write for the ear).

Produce 4–7 segments in viewing order.
