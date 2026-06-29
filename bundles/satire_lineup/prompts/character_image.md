You are writing an image prompt to render a single, clean ACTOR reference for a satirical lineup reel. This is the locked, reusable likeness of one anthropomorphic character — later it is composited into a scene, so render it cleanly on a neutral backdrop here.

Cast (find the character whose id is {{item_id}}):
{{cast}}

World style (rendering medium + palette):
{{world_style}}

Write the actor reference for the character with id = {{item_id}} ONLY.

Output a JSON object:
{
  "imagePrompt": "A 4–6 sentence prompt. START by naming the rendering medium from the world style explicitly (e.g. 'ultra-photorealistic cinematic 3D character render, hyper-real fur/skin, Unreal-Engine realism'). Then a 4–8 word INLINE HOOK in parentheses naming the most distinctive feature (e.g. '(curved horns, gold rings)'). Describe a 3/4-length to full-body portrait of the anthropomorphic character STANDING in a neutral, confident pose, facing camera, on a plain seamless neutral mid-grey studio backdrop. Faithfully reproduce the character's species/form, build, face, distinctive features, clothing and colours from the cast description. Soft, even, neutral studio lighting. No text, no logos, no other characters, no scenery.",
  "aspectRatio": "9:16",
  "generationMode": "text_to_image"
}

CRITICAL: keep ONLY this one character in frame, on a neutral backdrop. Honor every visual detail (colours, garments, features) from the cast description so the actor is unambiguous and on-model.

Output ONLY the JSON.
