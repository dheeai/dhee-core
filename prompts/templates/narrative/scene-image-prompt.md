# Scene Image Prompt Template

Generate a comprehensive image generation prompt for a scene image using character and setting references.

## Scene Information

{{SCENE_CONTENT}}

## Reference Images

### Characters in Scene
{{CHARACTER_REFERENCES}}

### Setting Reference
{{SETTING_REFERENCE}}

## Reference Handling

Your prompt names each character and setting directly by their
canonical name (e.g. "Sarah Chen", "the Manor Library"). The
executor handles reference-image slot binding deterministically by
prepending a manifest line to your prompt at render time. You
focus on the cinematic prose; slot numbers are not your concern.

## MANDATORY Composition Specifications

The prompt MUST include ALL of the following details. This scene will use image_text_to_image mode with the reference images above. The prompt text MUST reference the input images (image1, image2, etc.) so the model knows how to use them.

### 1. Reference Integration (ALL REQUIRED)

- **Character Reference IDs**: List all character ref IDs to use
- **Setting Reference ID**: The setting ref ID to use (if applicable)
- **Named References**: The prompt text names each character and
  setting directly (e.g. "Sarah Chen", "the Manor Library")
- **Consistency Notes**: Specific features that MUST match the references

### 2. Composition & Framing (ALL REQUIRED)

- **Shot Type**: (wide shot, medium shot, close-up, extreme close-up, over-the-shoulder, etc.)
- **Camera Angle**: (eye-level, low angle, high angle, Dutch angle, bird's eye, worm's eye)
- **Focal Point**: What draws the viewer's eye first
- **Character Positions**: Where each character is in the frame (left, center, right, foreground, background)
- **Depth of Field**: (shallow for intimacy, deep for context, rack focus between subjects)

### 3. Action & Moment (ALL REQUIRED)

- **Captured Moment**: The specific instant being depicted
- **Character Expressions**: Emotional state shown on each character's face
- **Body Language**: Posture, gesture, physical attitude of each character
- **Interaction**: How characters relate spatially and emotionally

### 4. Lighting & Mood (ALL REQUIRED)

- **Primary Light Source**: Direction and type
- **Light Quality**: (harsh, soft, dramatic, natural, artificial)
- **Shadow Character**: (long, short, diffuse, hard-edged)
- **Mood Contribution**: How lighting supports emotional tone
- **Color Grading**: Overall color treatment (warm, cool, desaturated, high contrast)

### 5. Technical Specifications (REQUIRED)

- **Aspect Ratio**: 16:9 (standard cinematic)
- **Mode**: image_text_to_image (using references)
- **Detail Level**: High detail in focal area, appropriate detail falloff

## Style Configuration

Style: {{STYLE_NAME}}
Style Modifiers: {{STYLE_MODIFIERS}}

## Output Format

Generate the prompt in this exact structure:

```
**Image Prompt:**
[Complete detailed prompt incorporating ALL mandatory elements above. Name each character and setting directly (e.g. "Sarah Chen", "the Manor Library"). Include character descriptions that match their references, setting that matches its reference, specific action/moment, composition, lighting. Single paragraph, no line breaks.]

**Reference Images:**
- Character: [name] (ref_id: [id])
- Character: [name] (ref_id: [id])
- Setting: [name] (ref_id: [id])

**Negative Prompt:**
{{STYLE_NEGATIVE_PROMPT}}, inconsistent character appearance, wrong character features, mismatched setting, multiple versions of same character, text, watermarks, poor composition, flat lighting

**Aspect Ratio:**
16:9

**Generation Mode:**
image_text_to_image
```

## Example Output

**Image Prompt:**
A medium shot of Dr. Sarah Chen, a South Asian woman in her mid-30s with jet black wavy hair and determined brown eyes, standing face-to-face with Marcus Webb, an African American man in his 40s with a grey-streaked beard and weathered face, in the Victorian manor library. Golden hour light streams through tall windows behind them, casting long dramatic shadows. Sarah's expression is intense, confrontational, arms crossed defensively. Marcus appears calm but guarded, hands in his coat pockets. They stand three feet apart in the center of the frame, mahogany bookshelves flanking them, a cold fireplace visible in the background. Shallow depth of field focuses on their faces, warm amber tones with cool shadow contrast, cinematic composition, photorealistic, dramatic lighting, high detail, film quality, 8k.

**Reference Images:**
- Character: Dr. Sarah Chen (ref_id: char_sarah_001)
- Character: Marcus Webb (ref_id: char_marcus_001)
- Setting: Manor Library (ref_id: setting_library_001)

**Negative Prompt:**
anime, cartoon, illustration, drawing, sketch, 2d, cel shaded, inconsistent character appearance, wrong character features, mismatched setting, multiple versions of same character, text, watermarks, poor composition, flat lighting

**Aspect Ratio:**
16:9

**Generation Mode:**
image_text_to_image
