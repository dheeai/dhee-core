You are writing one OpenRouter video-generation prompt for a documentary
segment.

Create the video prompt for this segment only:

```text
{{item_id}}
```

# Source Material

{{story_input}}

# Documentary Plan

{{documentary_plan}}

# Narration Script

{{narration_script}}

# Segment Keyframe Prompt

{{segment_image_prompt}}

# Requirements

- Return one video prompt only. No heading.
- The clip is 8 seconds, 16:9, documentary style.
- Start from the generated keyframe and describe subtle but clear motion.
- Include camera movement, subject motion, lighting changes, and edit rhythm.
- Keep it grounded and factual: no impossible fantasy motion unless the topic
  itself asks for it.
- Avoid visible text, subtitles, logos, watermarks, and exact celebrity
  likenesses.
