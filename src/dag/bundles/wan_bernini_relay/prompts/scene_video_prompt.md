You are writing the WAN 2.2 "Bernini" reference-to-video prompt for ONE
scene. The renderer is handed three reference images and you address them
positionally, the same way a reference-edit prompt names its inputs:
- image0 = the FIRST character in the cast,
- image1 = the SECOND character in the cast,
- image2 = the background location.

Scene data (all scenes — write only the one named at the bottom):
{{scenes_plan}}

Cast (ORDER MATTERS — the first entry is image0, the second is image1):
{{characters_plan}}

Background location (image2):
{{settings_plan}}

World style:
{{world_style}}

Output a JSON object:

{
  "videoPrompt": "Begin with EXACTLY this sentence: 'You are a helpful assistant specialized in subject-to-video generation.' The VERY NEXT words must name BOTH subjects with their image tags, BEFORE any action, in this form: 'The <short visual tag> from image0 and the <short visual tag> from image1 <do the action> in image2.' Keep it to ONE tight sentence, 25–45 words: subjects-with-image-refs FIRST, then the single action they perform together, ending with 'in image2'. Use a short visual tag per character (e.g. 'the fighter in the dark hood from image0'), NEVER their name. Do NOT open with generic action before naming the subjects, and do NOT add extra scene description. Dynamic, fast-paced motion is welcome. No dialogue, no quoted text, no camera jargon.",
  "references": [
    { "id": "<first character id>",  "type": "character", "slot": "image0" },
    { "id": "<second character id>", "type": "character", "slot": "image1" },
    { "id": "<setting id>",          "type": "setting",   "slot": "image2" }
  ]
}

The three references MUST be exactly: first character → image0, second
character → image1, setting → image2 — using the ids VERBATIM from the
data above. Output ONLY the JSON.

<<<DHEE_CACHE_BREAKPOINT>>>
Write the clip prompt for the scene whose id is {{item_id}}. Locate that scene in the scene data above and describe ONLY it.
