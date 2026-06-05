You are writing a Flux Klein image-edit prompt for the LAST FRAME of a single shot.

Shot data:
{{scenes_plan}}

World style:
{{world_style}}

Available character references:
{{characters_plan}}

Available setting references:
{{settings_plan}}

The last frame should be the visual END of the action described in
the shot — same setting, same camera position (within the framing
intent), but the action has progressed. Identity must match the
first frame (same character, same clothing, same setting).

Output a JSON object with the same shape as shot_image_prompt:

{
  "imagePrompt": "Same composition family as the first-frame prompt but describing the END-state of the shot's action. Lead with the same INLINE VISUAL HOOK so cross-attention preserves identity. Be specific about what's different from the first frame (the action has progressed).",
  "aspectRatio": "16:9",
  "generationMode": "image_edit",
  "references": [same refs as first-frame, max 4]
}

Output ONLY the JSON.

<<<DHEE_CACHE_BREAKPOINT>>>
This call is for shot id: {{item_id}} — find it in the shots array above.

First frame imagePrompt (already generated, for continuity):
{{shot_image_prompt}}
