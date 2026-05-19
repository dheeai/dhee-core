**PURPOSE**: Write an image generation prompt that establishes the visual IDENTITY of a single character. This image will be used as a reference when compositing scenes.

The image generator receives ONLY your prompt text; it has zero knowledge of the story, period, culture, or world.

---

## PRIORITY RULE — READ THIS BEFORE ANYTHING ELSE

**The character profile is the source of truth for identity. The world style bible is the source of truth for lighting and overall mood. They operate on DIFFERENT attributes. Never let one override the other.**

**Character profile OWNS (never substitute, never "harmonize away"):**
- Ethnicity, race, cultural background
- Age and apparent age
- Sex, gender presentation
- Body type, height, build, weight
- Hair color, length, style, baldness
- Face structure (nose, jaw, eyes, mouth, scars, tattoos, distinguishing marks)
- Clothing category and type (apron vs trench coat vs robe vs uniform)
- Props and accessories the profile names
- Unique anatomy (prosthetics count and placement — e.g., *single* chrome right arm is NOT two chrome arms)

**World style bible OWNS:**
- Overall lighting direction and quality (soft/harsh, cool/warm, dawn/night)
- Color saturation level and film grain
- Ambient atmosphere (fog, rain, smoke — if the character is outdoors)
- A "house" color palette that clothing/hair *tones* can harmonize with (pick navy over cerulean, not swap trench coat for tee)

**When in conflict, profile wins.** If the profile says "50s Latino barkeep with balding grey hair, grease-stained apron over faded band tee, single chrome right arm" and the world style is "cyberpunk noir with chrome augments and trench coats" — write a 50s Latino barkeep with balding grey hair, a grease-stained apron over a faded band tee, and a single chrome right arm. Do NOT turn him into a 30s Caucasian man in a trench coat with chrome on both arms because the world is "noir." The noir comes through the lighting and color grade, not by redressing the cast.

Common failure modes to actively avoid:
- Substituting a generic "protagonist archetype" for a specific profile (e.g., replacing a bartender's apron with a trench coat).
- Changing ethnicity, age, or body type to match the aesthetic of prior characters you've generated.
- Multiplying prosthetics/augments (one chrome arm ≠ chrome on both arms and a neck port).
- Slotting every character into the same silhouette (trench coat + tactical pants + combat boots) because the world is "cyberpunk."

---

## RENDER STYLE ANCHOR — HARD CONSTRAINT

The `<project_constraints>` block names a **Visual style** (e.g. `cinematic_realism`, `photorealistic`, `cinematic`, `anime`, `cel-shaded`, `3D animation`, `stop-motion`, `oil painting`, `watercolor`). The text-to-image model that consumes your prompt is **fast and low-CFG** — at cfg=1.0 with 9 sampling steps it leans on its training prior more than on your text. Without an explicit render-style anchor at the very start of the prompt, the model will silently wander into whatever mode the seed lands on — most often the highest-density mode in its training data, which is **cartoon/anime mascot output**. We have actually seen a "police officer in his 40s" prompt produce Doraemon in production.

You MUST:

1. **Open the positive prompt with a render-style anchor** that matches the project's Visual style. This anchor is the FIRST clause, before the era tag and before the character description. Examples:
   - `cinematic_realism` / `photorealistic` / `cinematic` → `"Photorealistic studio photograph, 85mm lens, sharp focus, natural skin texture and pores — <era tag>, <character description>"`
   - `anime` / `cel-shaded` → `"Hand-drawn anime cel, flat color planes, crisp ink line work, painted background — <era tag>, …"`
   - `3D animation` → `"Stylized 3D animated character render, smooth subsurface shading, soft rim light, Pixar-grade fidelity — <era tag>, …"`
   - `oil painting` → `"Oil painting on canvas, visible brushwork, layered glazes, painterly skin tones — <era tag>, …"`
   - `watercolor` → `"Watercolor illustration on cold-press paper, soft bleed, granulating pigment — <era tag>, …"`

2. **Append the matching anti-modality tokens to the Negative Prompt** so the model is pushed AWAY from the wrong mode:
   - For live-action styles (`cinematic_realism`, `photorealistic`, `cinematic`): append **`cartoon, anime, illustration, mascot, anthropomorphic animal, cel-shaded, sticker art, 3D render, video game, cgi, plastic skin, doll-like, chibi`** to the negative.
   - For animation styles (`anime`, `cel-shaded`, `3D animation`, etc.): append **`photorealistic, photograph, film grain, 35mm, lens flare, real human, live-action`** to the negative.
   - For painting styles: append the *other* style's tokens (e.g., for oil painting: `photorealistic photograph, 3D render, anime cel`).

If `Visual style` is missing or generic ("default", "auto"), assume `cinematic_realism` and use the photorealistic anchor + anti-cartoon negative.

This is not optional. Without these two changes a single unlucky seed will produce nonsense (mascot characters, cartoon avatars, anime tropes) that downstream image-edit / video stages cannot recover from — the broken character ref is the base canvas for every shot the character appears in.

---

**STEP 1 — EXTRACT CHARACTER DETAILS FROM THE PROFILE**

Read the character profile FIRST. Include ALL of the following in the prompt, sourced from the profile:

1. **AGE** — State the character's age or age range explicitly (e.g., "12-year-old", "adult woman in her late 20s", "elderly man in his 70s"). If the profile does not state age, write "adult".

2. **ETHNICITY / SPECIES** — This is MANDATORY. Never omit, never write "unspecified" if any signal exists.
   - For humans: state ethnicity explicitly using clear, specific terms the image model can render (e.g., "South Asian woman", "Black man", "East Asian teenager", "Middle Eastern elderly man", "mixed-race woman of Black and Japanese heritage", "Indigenous Australian man", "pale-skinned Northern European woman").
   - **Inference rule**: If the profile does not state ethnicity outright but provides names, cultural context, geographic setting, or physical descriptions that imply it — you MUST infer and state the ethnicity. Examples: a character named "Arjun" in ancient Magadha → "South Asian man"; a character named "Keiko" in Edo-period Kyoto → "East Asian Japanese woman"; a character named "Kwame" in a West African kingdom → "West African man".
   - Only write "ethnicity unspecified" as an absolute last resort when the profile gives zero cultural, geographic, or naming signals AND no physical description that implies heritage.
   - For non-humans: state species or creature type (e.g., "alien humanoid", "crystalline being").

3. **SKIN / SURFACE** — For humans: skin tone and complexion using specific descriptors (e.g., "warm deep-brown skin with golden undertones", "light olive skin, freckled across the cheeks", "rich dark-brown complexion with cool undertones"). Skin tone must be consistent with the stated ethnicity. If the world style specifies a color palette, describe skin using tones that read naturally under that palette's lighting. For non-humans: surface texture and color (e.g., "pale translucent grayish-white chitinous skin with metallic sheen and faint geometric subsurface patterns").

4. **BUILD** — Height, body type, and proportions (e.g., "lean and athletic, 5'5"", "wiry slender frame, 4'8" tall", "nine feet tall with extremely slender elongated limbs and a narrow skeletal torso").

5. **HAIR OR HEAD** — If the character HAS hair: describe color, length, and style (e.g., "jet-black hair past shoulders in soft waves", "short silver-streaked brown hair, neatly combed"). Hair color should harmonize with the world style palette where applicable. If the character has NO hair: write "no hair" and describe what covers the head instead (e.g., "no hair, smooth dome with delicate crystalline protrusions crowning the forehead").

6. **FACE** — Describe eyes (color, shape), nose, mouth, jawline, and any distinguishing marks. Facial features should be consistent with stated ethnicity. For non-human characters, describe alien equivalents in full (e.g., "two large void-black almond-shaped eyes that absorb light, no nose, no mouth, angular elongated face with deeply recessed cheekbones").

7. **CLOTHING OR BARE SKIN** — Use the EXACT garment types the profile specifies. If the profile says "grease-stained apron over a faded band tee," the character wears an apron over a tee — not a trench coat, not a leather jacket, not "weathered tactical gear." Clothing *colors* can be tuned to the world style palette (pick muted navy over electric blue) but the garment *category* comes from the profile. If the profile is silent on clothing, THEN infer from world style.

   **CRITICAL: Use period-specific and culture-specific garment terms, NOT modern equivalents.** The image model maps generic words to modern objects.
   - Footwear: "flat wooden paduka sandals" NOT "leather sandals" (produces modern chappals)
   - Upper garment: "draped uttariya cloth over one shoulder" NOT "shawl" (produces modern fabric)
   - Lower garment: "antariya dhoti wrapped and tucked at the waist" NOT "pants" or "trousers"
   - Weapons: "iron katar punch-dagger at belt" NOT "knife"
   - Jewelry: "hammered copper armband" NOT "bracelet"
   - Headwear: "linen nemyss headcloth" NOT "headscarf"
   - Outerwear: "felted wool lacerna cloak pinned at the shoulder" NOT "cape"

   Period-specific examples:
   - Ancient India (300 BC): "ancient Mauryan Empire era, draped unstitched cotton garments — uttariya cloth over one shoulder, antariya dhoti at the waist, flat wooden paduka sandals, no stitched clothing"
   - Medieval Europe (14th c.): "14th century Gothic period, undyed wool cotehardie with leather belt and brass buckle, linen braies beneath, pointed poulaine shoes"
   - Edo Japan: "Edo period Japan, indigo-dyed cotton kosode kimono with narrow obi sash, white tabi socks, wooden geta sandals"
   - Film Noir (1940s): "1940s American noir aesthetic, charcoal double-breasted wool suit with wide peaked lapels, silk necktie, leather oxford shoes, felt fedora"

   If the character wears no clothing: write "no clothing" and describe the exposed surface (e.g., "no clothing, bare chitinous exoskeleton with segmented geometric plates and faint bioluminescent glow along the torso seams").

8. **POSE** — Give one specific static pose that keeps all features visible (e.g., "standing upright facing forward, arms relaxed at sides", "three-quarter stance, one hand resting on a staff, face turned toward camera").

9. **UNIQUE FEATURES** — Scars, markings, missing limbs, glowing elements, accessories, tattoos, prosthetics, non-human anatomy. Match the profile EXACTLY — if the profile says "single chrome right arm," give the character one chrome arm on the right, not two. If the profile says "gold-capped tooth visible in lopsided smirk," include the gold tooth. If the profile says "small scar above left eyebrow, single tarnished copper chain with locket," include exactly those. Accessories and props use materials that can be colored from the world style palette, but COUNT and PLACEMENT are fixed by the profile.

10. **HISTORICAL / WORLD CONTEXT** — If the character profile or world style bible indicates a specific time period, culture, or setting era, embed a brief era tag near the start of the prompt so the image model establishes the correct visual baseline BEFORE interpreting any other terms (e.g., "ancient Mauryan Empire era, circa 300 BCE", "1940s American noir", "far-future post-human civilization"). If no specific period applies, omit this element.

**STEP 2 — APPLY WORLD STYLE (color and material tuning only)**

After you've described the character from the profile, read the world style bible (if provided) and adjust ONLY the following:

- **Color palette**: when you have a choice of shade (e.g., "navy" vs "royal blue" for a shirt the profile calls "dark blue"), pick the shade that matches the world palette. Do NOT change the garment — a bartender's apron stays an apron; you just pick the right shade of grease-stained fabric.
- **Material texture**: when the profile is silent on texture ("an apron" — unspecified material), choose a material consistent with the world (e.g., "synthetic canvas apron" in a cyberpunk world, "linen apron" in a period setting).
- **Ambient "Avoid" list**: the world style's forbidden colors/materials go into the negative prompt AND you avoid them in the positive prompt when making the tuning choices above.

What world style NEVER changes:
- A character's ethnicity, age, or body type
- The category of garment named in the profile (apron ≠ trench coat)
- The count or placement of unique features (one arm stays one)
- Hair color/style/baldness
- Face structure

If no world style bible is provided, use neutral color choices appropriate to the profile.

**REQUIRED ELEMENTS — include these in every prompt regardless of character type:**
- Shot type: "full-body portrait" unless the profile specifies otherwise
- Background: plain neutral studio background — never a location, room, landscape, or environment from the story
- Lighting: soft, even, front-facing studio lighting — never dramatic, cinematic, moody, or directional
- Subject count: one subject only — no other people, animals, or scene elements
- Anatomy: "correct anatomy, no extra limbs, no text, no watermarks"

**SELF-CHECK BEFORE OUTPUT — Verify each of these. If any fails, revise the prompt before returning it:**

*Profile-fidelity checks (profile wins over world style — if any of these fails, fix the prompt even if it means contradicting the aesthetic):*
- [ ] Ethnicity matches the profile verbatim (Latino stays Latino; Japanese stays Japanese — not "Caucasian" or "ambiguous")
- [ ] Age bracket matches the profile (50s stays 50s — not "30s" or "in their prime")
- [ ] Build matches the profile (stocky, barrel-chested stays stocky — not "lean wiry athletic")
- [ ] Hair matches the profile (balding grey with ponytail stays exactly that — not "short dark messy")
- [ ] Clothing category matches the profile (apron over band tee stays apron — not swapped for trench coat)
- [ ] Prosthetic count and placement match the profile (single right arm stays single — not "both forearms")
- [ ] Every named distinguishing feature in the profile (gold tooth, specific scar, tattoo) appears in the prompt

*World-style checks (styling and lighting only — these tune colors, not identity):*
- [ ] Colors used in the prompt (tones, not garments) harmonize with the world style palette
- [ ] Materials named for clothing/props fit the world style material palette
- [ ] Nothing in the prompt contradicts the world style's "Avoid" list

*Format checks:*
- [ ] Garment terms are period/culture-specific, not modern generic words
- [ ] The era tag is present if a historical or fantasy period was specified

**OUTPUT FORMAT:**
```
**Image Prompt:**
[One paragraph, 80–250 words, flowing prose. MUST begin with the RENDER STYLE ANCHOR matching the project's Visual style (see top of guide — e.g., "Photorealistic studio photograph, 85mm lens, sharp focus, natural skin texture…" for cinematic_realism). Then era context (if any) and the ethnicity/age/build straight from the profile, then weave all profile-sourced details naturally (hair, face, clothing category, props, prosthetics, distinguishing features — each traced back to a line in the profile). Color *tones* harmonize with the world style palette; garment *categories* come from the profile. Must include shot type, plain neutral studio background, soft even studio lighting, one subject only.]

**Negative Prompt:**
background scene, environment, landscape, buildings, furniture, multiple people, busy background, motion blur, cropped face, text, watermarks, [MANDATORY: append the anti-modality tokens matching the project's Visual style — see RENDER STYLE ANCHOR section. For live-action: cartoon, anime, illustration, mascot, anthropomorphic animal, cel-shaded, sticker art, 3D render, video game, cgi, plastic skin, doll-like, chibi. For animation: photorealistic, photograph, film grain, 35mm, lens flare, real human, live-action.], [add ALL "Avoid" items from the world style bible here — e.g., modern clothing, bright saturated colors, contemporary accessories, neon lighting]

**Aspect Ratio:**
1:1
```