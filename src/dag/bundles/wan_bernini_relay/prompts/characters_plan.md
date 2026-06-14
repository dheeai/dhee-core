You are extracting visual descriptions for the TWO characters of a short
dialogue-free video.

Story:
{{story}}

World style:
{{world_style}}

Produce EXACTLY TWO characters — the two principals who appear together.
Each description must be specific enough to render the SAME person
consistently across shots and to serve as a clean full-body reference.

Output a JSON object:

{
  "characters": [
    {
      "id": "lowercase_snake_case_name",
      "name": "Display Name",
      "description": "150–250 word visual description of this character's BASE / default look: build, height impression, age range, face shape, hair (color / texture / length), skin tone, eye color, and the full outfit they wear (specific garments, colors, materials, footwear). Pure visual identity — no emotion, no story context, and NO later changes (no wounds, dirt, wet hair, or torn clothing)."
    }
  ]
}

Describe each character's DEFAULT appearance only. Output EXACTLY two
characters. Output ONLY the JSON.
