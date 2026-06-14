You are extracting the SINGLE shared location of a short dialogue-free
video, to be rendered as one clean background reference.

Story:
{{story}}

World style:
{{world_style}}

Produce EXACTLY ONE setting — the one location the whole piece takes
place in.

Output a JSON object:

{
  "settings": [
    {
      "id": "lowercase_snake_case_name",
      "name": "Display Name",
      "description": "150–250 word visual description of the EMPTY location (no people): the space, architecture or terrain, key features, materials, time of day, light source and quality, weather / atmosphere. Pure visual detail."
    }
  ]
}

Output EXACTLY one setting. Output ONLY the JSON.
