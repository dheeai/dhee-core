# Segment Image Prompt → Ideogram 4 structured caption

Build a **structured JSON caption** that Ideogram 4 renders into one infographic
panel for a single segment. Ideogram renders this structured form far more
accurately than a plain sentence — especially the embedded text.

## Infographic plan

{{infographic_plan}}

## Outline (context)

{{outline}}

## Output

Focus ONLY on the segment whose id is given below. Output a JSON object in the
**exact Ideogram 4.0 caption schema** — three top-level keys:

```json
{
  "high_level_description": "one or two sentences summarizing the whole panel",
  "style_description": {
    "aesthetics": "minimal, clean, geometric, editorial",
    "lighting": "even diffuse light, no harsh shadows",
    "medium": "graphic_design",
    "art_style": "flat vector infographic, bold clean shapes, generous whitespace",
    "color_palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"]
  },
  "compositional_deconstruction": {
    "background": "string describing the panel background",
    "elements": [
      { "type": "text", "bbox": [y_min, x_min, y_max, x_max], "text": "EXACT TEXT TO RENDER", "desc": "relative styling: weight, scale, alignment, colour" },
      { "type": "obj",  "bbox": [y_min, x_min, y_max, x_max], "desc": "what to draw" }
    ]
  }
}
```

Rules (from the Ideogram 4.0 prompt guide):
- Match the schema above exactly. `style_description` MUST include `aesthetics`,
  `lighting`, `medium` (`"graphic_design"`), `art_style`, and `color_palette`.
- This is a PURE INFOGRAPHIC. **NO people, NO faces, NO talking heads, NO human figures or hands.** `obj` elements are charts, diagrams, icons, graphs, maps, arrows, data shapes — never a person. If the segment mentions people, represent them abstractly (icons, silhouettes, bars, pictograms), not as a rendered human.
- `bbox` is a normalized **1000×1000** grid `[y_min, x_min, y_max, x_max]` (top-left origin). Give each element a non-overlapping box. The panel is **16:9 landscape**, so the headline spans a wide top band; lay elements out left-to-right with generous spacing.
- `desc` describes styling **relatively — never in pixels**. Say "bold, large, centered" or "small caption, light weight", NOT "60px". Ideogram has no fixed canvas size, so pixel values are meaningless.
- Put EVERY word that must appear in the image into its own `text` element, verbatim (the segment's title, key stats/numbers, axis labels, captions). Use `\n` for line breaks within one text block; use SEPARATE elements for visually distinct blocks. Keep captions short — Ideogram garbles long small text.
- Colors are UPPERCASE `#RRGGBB`. Use `color_palette` (up to 16) to steer the look; a per-element `colors` array (up to 5) is OPTIONAL — only add it when an element's colour differs from the palette default. Don't repeat a hex in `desc` AND `colors`.
- Use the segment's `key_points`, `title`, and `visual_prompt` as the source of truth for the chart/diagram and labels. Do not invent statistics not in the plan.

Output ONLY the JSON object.

<<<DHEE_CACHE_BREAKPOINT>>>
For segment id: {{item_id}}
