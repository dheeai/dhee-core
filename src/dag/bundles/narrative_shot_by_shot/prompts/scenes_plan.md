You are breaking a short cinematic story into scenes and shots.

Story:
{{story}}

Story essence:
{{story_essence}}

Settings (the ONLY locations available — every `settingId` you emit MUST be one of these exact ids):
{{settings_plan}}

Target duration: {{targetDuration}} seconds total.

A scene is a contiguous unit in one location. A shot is a single
camera setup within a scene. Each shot has a fixed duration (use
clean integers, sum across all shots must equal the target
duration). Most shots should be 3–6 seconds. Cap at 8 shots total
per scene.

**Scene count — DO THIS FIRST, before writing any shots.** Scenes are
driven by LOCATION, not by story beats. Look at the `Settings` list and
walk the story in order, starting a new scene each time the camera moves
to a DIFFERENT location.

Within a single location, do NOT start a new scene for a new character,
a new action, a new story beat, or a shift in `narrativeMode` (that field
is a LABEL, not a reason to split). The ONLY reason to split a single
location into more than one scene is the 8-shot cap above: if one
location needs more than 8 shots, break it into consecutive scenes that
REUSE the same `settingId` (scene_1, scene_2, … all sharing that id) —
purely to respect the cap, never for narrative reasons. So a story that
happens entirely in one location across 20 shots is ~3 scenes that all
share ONE settingId — NOT 7 scenes split by what each character does.

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
      "settingId": "MUST be one of the exact ids from the Settings list above — never invent a new one"
    }
  ],
  "shots": [
    {
      "scene": 1,
      "shotNumber": 1,
      "duration": integer seconds,
      "description": "1–2 sentences: who/what is on camera, the action",
      "cameraWork": "1 sentence: framing + camera motion (e.g. 'medium close-up, slow push-in')",
      "mainSubject": "primary character id OR setting id this shot focuses on"
    }
  ]
}

Hard rules: sum of all shot durations == {{targetDuration}}. Set
`scene` to the scene number this shot belongs to and number shots
within each scene from 1 in `shotNumber` — do NOT emit a shot `id`;
the system constructs it from `scene` + `shotNumber`. Output ONLY the
JSON.
