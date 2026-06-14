# Character reference sheet → Ideogram 4 structured caption

Build a **structured JSON caption** that Ideogram 4 renders into ONE clean,
full-body character reference image. Ideogram renders this structured form
far more accurately than a plain sentence.

Character data:
{{characters_plan}}

World style:
{{world_style}}

This is a SINGLE-FIGURE REFERENCE SHEET — exactly one person, the whole
body head-to-feet, standing in a relaxed front-facing neutral pose with
arms at the sides, on a plain seamless studio backdrop. It drives a
subject-to-video model, so the face, the full outfit, and the complete
silhouette must be crisp and unobstructed.

Output a JSON object in the **exact Ideogram 4.0 caption schema** — three
top-level keys:

```json
{
  "high_level_description": "one or two sentences: a full-body studio reference of the character (a photograph, OR an illustration / 3D render matching the world-style medium), naming the most distinctive features and the outfit.",
  "style_description": {
    "aesthetics": "clean, neutral, reference-sheet",
    "lighting": "even soft neutral studio lighting, no harsh shadows",
    "medium": "photograph",
    "art_style": "the world style's RENDERING MEDIUM verbatim (e.g. 'cinematic photorealism' — or a named anime / illustration style)",
    "color_palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"]
  },
  "compositional_deconstruction": {
    "background": "a plain seamless light-grey studio backdrop, completely empty — no props, no scenery, no text",
    "elements": [
      { "type": "obj", "bbox": [30, 320, 985, 680], "desc": "the FULL-BODY figure, head to feet, centered and front-facing in a relaxed neutral pose with arms at the sides. Describe build, age range, face, hair, skin tone, and the COMPLETE outfit (every garment with colour + material) and footwear, drawn from the character data. The whole body is in frame and in sharp focus." }
    ]
  }
}
```

Rules (from the Ideogram 4.0 prompt guide):
- Match the schema exactly. `style_description` MUST include `aesthetics`,
  `lighting`, `medium`, `art_style`, and `color_palette`.
- EXACTLY ONE `obj` element: the single full character. Do NOT split the
  person into parts — head, torso, limbs, and clothing are attributes of
  that one element's `desc`.
- NO `text` elements, NO other people, NO props, NO scenery. The backdrop
  is a plain studio seamless described in `background`.
- The figure MUST be FULL-BODY (head to feet), centered, with a little
  headroom above and floor below. The frame is **2:3 PORTRAIT**.
- `bbox` is a normalized **1000×1000** grid `[y_min, x_min, y_max, x_max]`,
  top-left origin. Keep the figure's box tall and centered.
- `medium` / `art_style` MUST match the world style; if it is illustrated
  / anime / painterly, say so explicitly or it renders as a photo.
  `color_palette` hexes are UPPERCASE `#RRGGBB`.

Output ONLY the JSON object.

<<<DHEE_CACHE_BREAKPOINT>>>
For character id: {{item_id}} — find it in the character data above and write the reference-sheet caption for ONLY that character.
