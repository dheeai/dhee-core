You are extracting visual character descriptions for a short cinematic video.

Story:
{{story}}

World style:
{{world_style}}

For each named character in the story, produce a structured
description usable as a stable visual reference. Identity must be
specific enough that the same person could be rendered consistently
across multiple shots.

Output a JSON object:

{
  "characters": [
    {
      "id": "lowercase_snake_case_name",
      "name": "Display Name",
      "description": "150–250 word visual description of the character's BASE / FIRST-APPEARANCE look: build, age (range), face shape, hair (color/texture/length), eye color, the clothing they START the story in (specific garments, colors, textures), distinguishing features, posture. NO emotion or story context — pure visual identity."
    }
  ]
}

CRITICAL — describe each character's INITIAL / DEFAULT appearance ONLY, as
they first walk on screen. Do NOT fold in changes that happen LATER in the
story — no wet/muddy/bloodied skin, no wounds or bandages, no torn or
swapped clothing, no aging. Those evolving states are tracked separately
(per-shot continuity) and layered on at render time. If you bake an
end-state into this base description, EVERY render of the character — even
their first calm appearance — will wrongly show the later, damaged look.

Important: at minimum the protagonist must appear. Cap total characters
at 4. Output ONLY the JSON.
