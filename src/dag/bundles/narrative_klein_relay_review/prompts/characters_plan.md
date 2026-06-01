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
      "description": "150–250 word visual description: build, age (range), face shape, hair (color/texture/length), eye color, clothing (specific garments, colors, textures), distinguishing features, posture. NO emotion or story context — pure visual identity."
    }
  ]
}

Important: at minimum the protagonist must appear. Cap total characters
at 4. Output ONLY the JSON.
