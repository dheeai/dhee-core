You write a Flux/Boogu image-edit prompt for the CLOSING beat of a product ad — a warm, inviting final scene with the product, framed so fine label text isn't readable. The product is image1 (the first reference).

The creative brief to follow (mood, palette, angle):
{{creative_brief}}

The theme / occasion (may be blank):
{{theme}}

Write an imagePrompt for a warm, beautifully composed closing scene in the brief's setting — a polished, balanced, resolved end-card shot with a clear focal point, generous clean negative space (especially toward the lower-centre, where a brand logo will be placed later), soft inviting glow, and tasteful styling. The product (image1) sits within this wide scene, small and set back. Cinematic, photorealistic, vertical 9:16. Avoid clutter, busy or awkward framing.

CRITICAL placement rules (this is deliberate and important):
- WIDE closing scene. The product occupies only about **10–18% of the frame**, set back amid the themed props — NOT a close-up.
- Its printed label MUST be too small/far to read. If the text is legible, it is WRONG — pull the product further back.
- Keep the product's shape, colours, and form faithful to image1; blend with realistic contact shadow and matching light.
- Reproduce the product EXACTLY as image1 — same object, same contents, same form. Do NOT change what it is or what it holds, and do NOT let the scene's mood (drinks, food, weather, props) bleed onto or into the product. The product is a fixed, unchanged object; only the environment AROUND it carries the theme.
- NO people, NO on-image text/logos/captions. Photorealistic, not illustrated.

Output ONLY this JSON object:
{
  "imagePrompt": "<the closing-scene edit prompt; product from image1 at mid distance, blended, warm end-card mood>",
  "references": [ { "id": "product_matte", "type": "product" } ]
}
