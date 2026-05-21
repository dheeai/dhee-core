# Shot Image Prompt Template

Generate an image prompt for a specific shot within a multi-shot scene breakdown. This image will be used as the source frame for video generation of this shot.

## Continuity Priority

- Preserve the established scene look before adding novelty
- Keep character appearance, wardrobe, props, setting anchors, lighting, and palette consistent with the scene continuity context
- Change only what this shot requires: framing, camera angle, composition, and immediate action
- If earlier shots in the same scene already establish visual details, reuse them unless the scene text explicitly changes them
- Treat any "do not change" notes in the context as hard constraints

## Shot Information

{{SHOT_CONTENT}}

## Shot-Specific Composition

The image must match the shot's framing. Different shot types require different compositions:

| Shot Type | Composition |
|-----------|-------------|
| **extreme_wide** | Vast environment, character tiny or absent, establishes scale |
| **wide / establishing** | Full environment, characters head-to-toe, establishes location |
| **medium_wide** | Character from knees up, physical action with environment |
| **medium** | Waist-up of character(s), conversational distance |
| **medium_close_up** | Chest and head, intimate, expression and gesture |
| **close_up** | Face fills frame, maximum emotional impact, shallow DOF |
| **extreme_close_up** | Single feature (eyes, hands, object), intense detail |
| **low_angle** | Camera below subject — powerful, dominant, imposing |
| **high_angle** | Camera above subject — smaller, vulnerable |
| **dutch_angle** | Tilted frame — unease, tension |
| **birds_eye** | Directly above — abstract, pattern view |
| **reaction** | Character responding — facial expression and body language |
| **over_the_shoulder** | Behind one character looking at another |
| **two_shot** | Two characters together, showing relationship |
| **pov** | Point-of-view — what a character sees |
| **insert** | Detail shot of object or action |
| **cutaway** | Brief shot of related element outside main action |
| **tracking** | Camera follows moving subject, dynamic composition |

## Reference Image Rules

- Use ONLY the character/setting references relevant to THIS shot
- For close-ups: only the featured character's reference
- For establishing/wide shots: all character + setting references
- Name characters and settings directly in the prose by their canonical
  names (e.g. "Ruby walks toward Angel", "the bus station platform").
  Slot binding is handled deterministically by the executor — a
  manifest line is prepended to your output at render time. You do
  not need to mention slot numbers.

## Output Format

When reference images EXIST:
```
**Image Prompt:**
[Single detailed paragraph matching the shot's framing. Name characters and settings directly.]

**Reference Images:**
- Character: [name] [path/to/character_ref.png]
- Setting: [name] [path/to/setting_ref.png]

**Negative Prompt:**
[Style-appropriate negatives + inconsistent appearance, wrong features]

**Aspect Ratio:**
1:1

**Generation Mode:**
image_text_to_image
```

**IMPORTANT**: Always include the actual file path in square brackets after each reference name. Use `list_project_files` to find the exact paths of character and setting reference images. The path should be relative to the project directory (e.g., `assets/images/0jZCrE-k_CharRef_Parvati_00001_.png`). This ensures reliable image resolution during generation.

Also explicitly carry forward continuity anchors from the provided context into the image prompt text:
- stable face/hair/body descriptors
- same wardrobe and key props
- same room/set dressing and geography
- same scene lighting direction and palette
- same emotional tone unless the shot description changes it

When NO reference images exist:
```
**Image Prompt:**
[Single detailed paragraph with all visual details self-contained]

**Negative Prompt:**
[Style-appropriate negatives]

**Aspect Ratio:**
1:1

**Generation Mode:**
text_to_image
```
