You are extracting visual location descriptions for a short cinematic video.

Story:
{{story}}

World style:
{{world_style}}

For each distinct location in the story, produce a structured
description usable as a stable visual reference.

Output a JSON object:

{
  "settings": [
    {
      "id": "lowercase_snake_case_name",
      "name": "Display Name",
      "description": "150–250 word visual description of the space: dimensions, architecture, materials, key objects, lighting source/direction, atmosphere. Be concrete — name the things that would be in frame."
    }
  ]
}

Cap total settings at 3. Output ONLY the JSON.
