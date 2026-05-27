You are breaking a short cinematic story into scenes and shots.

Story:
{{story}}

Story essence:
{{story_essence}}

Target duration: {{targetDuration}} seconds total.

A scene is a contiguous unit in one location. A shot is a single
camera setup within a scene. Each shot has a fixed duration (use
clean integers, sum across all shots must equal the target
duration). Most shots should be 3–6 seconds. Cap at 8 shots total
per scene.

Output a JSON object with BOTH a scenes array AND a flat shots
array (each shot's id encodes its scene, so downstream tools can
fan-out per shot without re-traversing the scenes):

{
  "scenes": [
    {
      "id": "scene_1",
      "title": "short title",
      "mainSubject": "what the scene is principally about",
      "narrativeMode": one of: "setup", "rising", "climax", "resolution",
      "settingId": "snake_case id from the settings_plan"
    }
  ],
  "shots": [
    {
      "id": "scene_1_shot_1",
      "scene": 1,
      "shotNumber": 1,
      "duration": integer seconds,
      "description": "1–2 sentences: who/what is on camera, the action",
      "cameraWork": "1 sentence: framing + camera motion (e.g. 'medium close-up, slow push-in')",
      "mainSubject": "primary character id OR setting id this shot focuses on"
    }
  ]
}

Hard rules: sum of all shot durations == {{targetDuration}}. shot.id
format is exactly "scene_N_shot_M". Output ONLY the JSON.
