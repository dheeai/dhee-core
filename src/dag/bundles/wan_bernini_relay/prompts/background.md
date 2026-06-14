# Background plate → Ideogram 4 structured caption

Build a **structured JSON caption** that Ideogram 4 renders into ONE empty
background plate — the single location the video plays in, with no people.
Ideogram renders this structured form far more accurately than a plain
sentence.

Setting data:
{{settings_plan}}

World style:
{{world_style}}

This is an EMPTY ESTABLISHING BACKGROUND — a wide shot of the location with
NO people, NO characters, NO text. It is the backdrop the action plays in
front of.

Output a JSON object in the **exact Ideogram 4.0 caption schema** — three
top-level keys:

```json
{
  "high_level_description": "one or two sentences: a wide establishing shot of the EMPTY location at the story's time of day (a photograph, OR an illustration / 3D render matching the world-style medium).",
  "style_description": {
    "aesthetics": "...",
    "lighting": "...",
    "medium": "photograph",
    "art_style": "the world style's RENDERING MEDIUM verbatim",
    "color_palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"]
  },
  "compositional_deconstruction": {
    "background": "the location's overall shell — sky / ceiling, ground / floor, walls or terrain, atmosphere, light, and depth",
    "elements": [
      { "type": "obj", "bbox": [y_min, x_min, y_max, x_max], "desc": "a distinctive structural or terrain feature of the location" }
    ]
  }
}
```

Rules (from the Ideogram 4.0 prompt guide):
- Match the schema exactly. `style_description` MUST include `aesthetics`,
  `lighting`, `medium`, `art_style`, and `color_palette`.
- NO people, NO faces, NO figures, NO `text` elements. Empty location only.
- 1–4 `obj` elements for the location's distinctive STRUCTURAL / terrain
  features (architecture, terrain, fixtures, light sources, signage SHAPES
  without readable text). The shell — sky, ground, walls, atmosphere —
  goes in `background`, never as an element.
- The frame is **16:9 LANDSCAPE**. `bbox` is a normalized **1000×1000**
  grid `[y_min, x_min, y_max, x_max]`, top-left origin.
- `medium` / `art_style` MUST match the world style; if illustrated / anime
  / painterly, say so explicitly. `color_palette` hexes are UPPERCASE.

Output ONLY the JSON object.

<<<DHEE_CACHE_BREAKPOINT>>>
For setting id: {{item_id}} — find it in the setting data above and write the background caption for ONLY that setting.
