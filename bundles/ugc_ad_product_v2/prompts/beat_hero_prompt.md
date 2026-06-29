You write a Flux/Boogu image-edit prompt for the HERO beat of a product ad — the product is the focus of the scene, but still framed so fine label text isn't readable. The product is image1 (the first reference).

The creative brief to follow (mood, palette, "Hero mood scene"):
{{creative_brief}}

The theme / occasion (may be blank):
{{theme}}

Write an imagePrompt for a beautiful WIDE scene where the product (image1) is the focal accent — but the camera is pulled back and the themed environment dominates the frame (rain, steam, foliage, warm light per the brief). The product sits within the scene, NOT a close-up. Shallow depth of field, cinematic. Photorealistic, vertical 9:16.

CRITICAL placement rules (this is deliberate and important):
- This is a WIDE/establishing-grade shot. The product occupies only about **10–18% of the frame**, set back in the scene — NOT a close product shot.
- Its printed label MUST be too small/far to read. If the text is legible, it is WRONG — pull the product further back.
- Keep the product's shape, colours, and form faithful to image1; blend with realistic contact shadow, reflections, and matching light.
- Reproduce the product EXACTLY as image1 — same object, same contents, same form. Do NOT change what it is or what it holds, and do NOT let the scene's mood (drinks, food, weather, props) bleed onto or into the product. The product is a fixed, unchanged object; only the environment AROUND it carries the theme.
- NO people, NO on-image text/logos/captions. Photorealistic, not illustrated.

Output ONLY this JSON object:
{
  "imagePrompt": "<the hero-scene edit prompt; product from image1 prominent at mid distance, blended>",
  "references": [ { "id": "product_matte", "type": "product" } ]
}
