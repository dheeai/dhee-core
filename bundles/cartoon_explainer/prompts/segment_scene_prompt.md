# Segment Scene Prompt → Ideogram 4 cartoon-scene caption

Build a **structured JSON caption** for ONE vivid **cartoon explainer scene** that
*illustrates* this segment's idea — a single cohesive illustrated moment with
characters, a setting, and visual metaphor — NOT a chart or infographic. Render
the segment's headline number/phrase as bold in-scene text (a sign, banner,
screen, or speech). Ideogram 4 renders this structured form most accurately.

## Infographic plan

{{infographic_plan}}

## Outline (context)

{{outline}}

## Output

Focus ONLY on the segment whose id is given below. Output a JSON object in the
**exact Ideogram 4.0 caption schema** — three top-level keys:

```json
{
  "high_level_description": "one or two sentences describing the whole cartoon scene and the metaphor it uses to explain this segment's idea",
  "style_description": {
    "aesthetics": "playful, vibrant, friendly cartoon explainer",
    "lighting": "bright, cheerful, soft cartoon shading",
    "medium": "illustration",
    "art_style": "modern flat 2D cartoon, thick clean outlines, bold saturated colors, expressive characters, simple shapes, motion-graphics explainer look (think TED-Ed / Kurzgesagt energy)",
    "color_palette": ["#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB", "#RRGGBB"]
  },
  "compositional_deconstruction": {
    "background": "string describing the scene setting",
    "elements": [
      { "type": "obj",  "bbox": [y_min, x_min, y_max, x_max], "desc": "a character / prop / metaphor object in the scene, with pose and expression" },
      { "type": "text", "bbox": [y_min, x_min, y_max, x_max], "text": "THE KEY NUMBER OR PHRASE", "desc": "relative styling: bold playful display lettering, placement" }
    ]
  }
}
```

Rules (from the Ideogram 4.0 prompt guide):
- Match the schema exactly. `style_description` MUST include `aesthetics`, `lighting`, `medium` (`"illustration"`), `art_style`, and `color_palette`.
- This is a **CARTOON SCENE**, not an infographic. Use **characters, mascots, and visual metaphors** to dramatize the idea (e.g. a rocket racing past slower vehicles for "fastest adoption"; a tiny seed growing into a giant money beanstalk for "market growth"; a character whose tiny notebook becomes a vast library for "context window"). Stylized cartoon people/creatures are welcome.
- Render the segment's single most important number or phrase as ONE bold `text` element (a banner/sign/screen). Put any other essential label in its own short `text` element. Keep on-image text SHORT — a few words — Ideogram garbles long small text.
- `bbox` is a normalized **1000×1000** grid `[y_min, x_min, y_max, x_max]` (top-left origin), non-overlapping. The panel is **16:9 landscape**; compose a balanced scene with a clear focal character/object.
- `desc` describes things **relatively — never in pixels** ("large, centered, bold"), never "60px".
- Colors are UPPERCASE `#RRGGBB`. Steer the look via `color_palette` (up to 16); a per-element `colors` array (up to 5) is OPTIONAL.
- Use the segment's `key_points`, `title`, and `visual_prompt` for the idea + the exact number/label. Do NOT invent statistics not in the plan. Keep it ONE clear scene — don't cram multiple metaphors.

Output ONLY the JSON object.

<<<DHEE_CACHE_BREAKPOINT>>>
For segment id: {{item_id}}
