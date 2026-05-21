**PURPOSE**: Define the visual and auditory world of this project in one document. This "style bible" ensures every shot, image, and video in the project shares a consistent look and feel.

## RENDER STYLE — HARD CONSTRAINT

The `<project_constraints>` block in your context names a **Visual style** (e.g. `anime`, `cel-shaded`, `3D animation`, `stop-motion`, `photorealistic`, `cinematic-realism`, `cinematic`, `oil painting`, `watercolor`). This is the rendering aesthetic the project will be drawn in — every section of the bible you write must use vocabulary that matches it. Drift in either direction will be faithfully implemented by every downstream image prompt, and the project will look wrong.

If the Visual style is animation / illustrated (anime, cel-shaded, 3D animation, stop-motion, oil painting, watercolor, comic, graphic-novel):

- **DO use** drawing/painting vocabulary: hand-drawn line work, ink-line thickness, cel shading, flat color planes, gradient-shaded skin, painted backgrounds with visible brushwork, hard shadow edges in direct sunlight, key-frame poses, anime hair highlights, exaggerated expression beats, halftone shading, cel-edge rim light.
- **DO NOT use** live-action cinematography vocabulary: 35mm film, 16mm film, film grain (unless deliberately stylized), lens (any focal length), shallow depth of field as a rendering property (it can describe in-frame focus but never as a "lens" reference), camera shake, handheld documentary feel, lens flare from physical glass, anamorphic distortion, digital clean.

If the Visual style is live-action (photorealistic, cinematic, cinematic-realism, documentary):

- **DO use** lens / film / camera vocabulary: 35mm or 85mm lens, film stock reference, shallow / deep depth of field, handheld vs locked-off camera, lens flare, anamorphic, color grade reference (teal/orange, bleach bypass, etc.).
- **DO NOT use** drawing vocabulary: line work, cel shading, flat color planes, painted backgrounds, ink lines.

The "Visual Tone" section below explicitly lists film-stock examples — those examples apply ONLY when Visual style is live-action. For animation styles, substitute the drawing-vocabulary equivalents (line weight, shading style, painted background treatment, key-frame pose energy).

If the Visual style field is missing or generic ("default", "auto"), assume cinematic-realism and use live-action vocabulary.

## PERIOD ACCURACY — HARD CONSTRAINT

If the plot / story / user input names a historical period (e.g. "300 BC", "Mauryan", "Mughal", "Vedic", "Iron Age", "Renaissance", "medieval", "Victorian", "ancient Rome"), every visual and auditory element you describe must be appropriate to that era. Treat the period as immovable; do not let modern noir / cinematic genre conventions drift you into post-period artifacts.

Anachronism cheat sheet — DO NOT introduce these in a pre-industrial setting:
- **Industrial materials**: corrugated iron (1820+), galvanized steel, plate glass, concrete, asphalt, plastic, chrome, aluminum, sheet rubber.
- **Mechanical/electric tech**: engines (steam, combustion, electric, ferry, motorcycle), generators, fluorescent / neon / LED light, fans, refrigerators, cameras, phones, radios, televisions, computers, microphones, loudspeakers.
- **Modern firearms**: revolvers, pistols, rifles, bullets, gunpowder weapons (gunpowder only reached widespread use ~14th c. CE in Asia; absent from 300 BC).
- **Modern transportation**: automobiles, trains, paved highways, motorcycles, motorboats, helicopters, airplanes.
- **Modern apparel/accessories**: trench coats, sneakers, jeans, T-shirts, hoodies, fedoras, sunglasses, wristwatches, ballpoint pens.
- **Sound world specifics**: anything mechanical, motorized, or amplified.

Period-appropriate substitutes (examples for ancient India / 300 BC):
- Roof material: thatch, palm-frond, fired-clay tile, reed mat, stone slab — NOT corrugated iron.
- Boat sound: wooden oar against hull (*dhak-dhak*), ferryman's chant, sail flapping — NOT engine *dhak-dhak*.
- Light source: oil lamps, iron torches, hearth fire, tandoor coals, moonlight — NOT electric, neon, fluorescent.
- Apparel: dhoti, sari, uttariya (shoulder cloth), turban, ghagra, kurta, bare feet, leather sandals — NOT trench coats, hoodies, modern footwear.
- Weapons: sword, dagger, spear, bow, mace, chakram — NOT firearms.
- Containers: clay pot, copper vessel, brass jug, leaf cup, palm-leaf scroll — NOT plastic, glass bottles, paper notebooks.

The plot and story already encode the era through their named locations and objects. Read them carefully and let those details anchor every choice you write here. When in doubt, ground in archaeologically attested materials and practices from the named period.

---

## What To Produce

A concise style reference covering:

### Color Palette
- Dominant colors (2-3), accent colors (1-2), color temperature (warm/cool/neutral)
- Which colors belong to which settings or characters
- Any color that should NOT appear

### Lighting
- Key light direction and quality (harsh/soft, natural/artificial)
- How lighting differs between settings (outdoor vs indoor, day vs night)
- Practical light sources in the story (lamps, screens, fire, neon)

### Time Progression
- What time of day each scene takes place
- How light changes across the story (dawn → midday → dusk)

### Atmosphere
- Physical conditions: haze, dust, rain, humidity, clean air, steam
- Per-setting atmosphere if it varies

### Visual Tone
- Contrast level (high/low), saturation, grain/texture
- Lens style: shallow DOF on characters, deep focus on wides
- Any film stock or camera reference (35mm, digital clean, handheld)

### Recurring Motifs
- Textures, materials, or visual elements that repeat across scenes
- Symbolic objects or visual metaphors from the story

### Sound World
- Base ambient per setting (city hum, forest, industrial, silence)
- Recurring sounds that define the world
- Music direction if applicable

---

## Rules

- Be specific — "warm golden" not "nice lighting"
- Reference the story and settings for accuracy
- Keep it under 500 words — this gets injected into every downstream prompt
- Do not describe plot or character arcs — only visual/auditory style

Output ONLY the style document — no explanations, no meta-commentary.
