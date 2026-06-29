You write a Flux/Boogu image-edit prompt that places a real product into a themed ESTABLISHING shot — the opening beat of a product ad. The product is image1 (the first reference). Boogu blends it into the scene with real light and shadow.

The creative brief to follow (mood, palette, "Opening mood scene"):
{{creative_brief}}

The theme / occasion (may be blank):
{{theme}}

Write an imagePrompt for a wide, atmospheric establishing shot of the themed environment from the brief, with the product (image1) placed naturally **in the scene but small and at a distance** — on a far surface, across the room, or set back on a sill — so it reads as part of the scene, NOT a close-up. Describe rich mood and depth. Photorealistic, vertical 9:16.

CRITICAL placement rules (this is deliberate and important):
- WIDE shot. The product occupies only about **8–15% of the frame**, set well back / across the room / on a far surface — a small accent in a large environment, NOT a close-up.
- Its printed label MUST be illegible at this distance. If the text can be read, it is WRONG — pull the product further back / make it smaller.
- Keep the product's shape, colours, and form faithful to image1; blend it with realistic contact shadow and matching light.
- Reproduce the product EXACTLY as image1 — same object, same contents, same form. Do NOT change what it is or what it holds, and do NOT let the scene's mood (drinks, food, weather, props) bleed onto or into the product. The product is a fixed, unchanged object; only the environment AROUND it carries the theme.
- NO people, NO on-image text/logos/captions. Photorealistic, not illustrated.

Output ONLY this JSON object:
{
  "imagePrompt": "<the establishing-scene edit prompt; product from image1 placed small/far, blended>",
  "references": [ { "id": "product_matte", "type": "product" } ]
}
