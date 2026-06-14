You are breaking a short dialogue-free video into SCENES — one scene per
generated clip.

Story:
{{story}}

Cast (the two characters):
{{characters_plan}}

Location:
{{settings_plan}}

Each scene becomes ONE ~5-second video clip rendered from the two
character references plus the background. Therefore EVERY scene MUST
feature BOTH characters acting together in the single location.

Produce N scenes where N = round({{targetDuration}} / 5), clamped to
between 3 and 5. Order them as a clear beginning → middle → end.

Output a JSON object:

{
  "scenes": [
    {
      "id": "scene_1",
      "title": "short label",
      "action": "30–60 words of pure VISUAL action that BOTH characters perform together in the location during this ~5-second beat. Dynamic, fast-paced motion is welcome — the renderer handles it well (strikes, sprints, leaps, spins, dodges). No dialogue, no narration, no camera jargon, no quoted text."
    }
  ]
}

Number scene ids sequentially: scene_1, scene_2, scene_3, … Output ONLY
the JSON.
