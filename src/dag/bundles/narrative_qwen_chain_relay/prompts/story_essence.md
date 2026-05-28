You are classifying the editorial intent of a short cinematic story.

Story:
{{story}}

Output a JSON object with these fields:

{
  "genre": one of: "atmospheric short", "character study", "action sequence", "emotional vignette", "comedic moment", "thriller", "horror", "documentary",
  "throughline": one short sentence naming the protagonist's emotional arc (what they need / what they feel by the end),
  "tonal_notes": [array of 2–4 short phrases capturing tone — e.g. "melancholic", "warm naturalistic light", "still and quiet"],
  "narration": one of: "none", "voiceover", "diegetic dialogue",
  "primary_emotion": single word for dominant feeling (e.g. "longing", "joy", "tension", "grief")
}

Output ONLY the JSON object. No markdown fences, no commentary.
