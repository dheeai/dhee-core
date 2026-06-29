You are writing ONE rich text-to-image prompt for the locked FIRST FRAME of a talking-head shot: a single anthropomorphic character, fully in character, standing/sitting in its own setting, about to speak to camera. This frame is later animated for lip-sync, so frame it cleanly with the character facing the viewer.

Cast (find the character whose id is {{item_id}}):
{{cast}}

World style (rendering medium + palette + lighting):
{{world_style}}

Write the first frame for the character with id = {{item_id}} ONLY, fusing its `description` (the actor) and its `setting` (the location) into one image.

CRITICAL ORDERING — the image model weights the FIRST clauses most, so the EXPRESSION must come EARLY, not at the end. Compose the imagePrompt in THIS order:
1. FIRST clause: the rendering medium EXACTLY as named in the world style (e.g. a stylized 3D cartoon / Pixar-style render, OR photoreal cinematic — whatever the world style specifies). Do not default to photoreal if the world style asks for cartoon.
2. IMMEDIATELY THEN (this is the most important sentence): the character caught at the PEAK of its `emotion`, described as a vivid, exaggerated cartoon KEY-POSE of FACE + BODY — lead with the face. Be concrete and physical, e.g.:
   - shock/surprise → "eyes bulging huge, brows shot up, jaw dropped wide open, head recoiling back, both arms flying up"
   - agony/anguish → "face contorted in pain, eyes screwed up, mouth wrenched open in a grimace, both forelimbs clutching the sides of his head"
   - manic glee → "an unhinged ear-to-ear open-mouthed grin, eyes wild, head tilting back mid-cackle"
   - smug/greedy → "a fat self-satisfied smirk, heavy-lidded eyes, chin raised"
   - defiant/heroic → "jaw set, a fierce confident half-grin, leaning hard toward camera, one claw pointing"
   The MOUTH is OPEN mid-exclamation (never closed/neutral). The emotion must be legible from a thumbnail. Match the specific `emotion` of THIS character.
3. THEN the identity: the upright ANTHROPOMORPHIC figure — species head fused with a humanlike body and expressive humanlike face, build, distinctive features, clothing and colours EXACTLY as in the description.
4. THEN the setting (from `setting`) with key props, in light matching the world style.
5. Framing: vertical 9:16 medium / medium-close, single character to camera. One character only. No on-screen text, no logos, no extra figures.

Output a JSON object EXACTLY in this shape (lead the imagePrompt with medium + the peak-expression key-pose):
{
  "imagePrompt": "<medium, THEN the peak-emotion face+body key-pose, THEN identity, THEN setting — 5–8 sentences>",
  "aspectRatio": "9:16",
  "generationMode": "text_to_image"
}

Output ONLY the JSON.
