You are breaking a short cinematic story into scenes and shots.

Story:
{{story}}

Story essence:
{{story_essence}}

Target duration: {{targetDuration}} seconds total.

A scene is a contiguous unit in one location/setting. A shot is a
single camera setup within a scene. Each shot has a fixed duration
(use clean integers, sum across all shots must equal the target
duration). Most shots should be 3–6 seconds.

**Scene count rule.** Scene boundaries are SETTING CHANGES in the
story, not duration buckets. Walk through the story in order and
start a new scene every time the camera cuts to a different
location/setting from `settings_plan`. Examples:

  - Entire story in one room → 1 scene (even at 180s).
  - Room → cutaway to cubicle → back to room → 3 scenes
    (scene_1=room, scene_2=cubicle, scene_3=room again). Scene 1
    and Scene 3 reuse the SAME `settingId` because the setting
    repeats, but they're separate scenes because the camera left
    and came back.
  - Room → 5-shot montage of 4 different intercut locations at
    the end → 1 main scene + 1 montage scene (the montage is one
    scene because the rapid-cut sequence is conceptually one beat,
    even though it shows multiple settings; assign its settingId
    to the "montage" settings_plan entry).

A typical short film is 1–4 scenes. Setting reuse is fine — just
emit a new scene_N each time the location changes.

Within a scene, use however many shots you need to fill the time at
3–6s each. A 180-second one-room scene is roughly 30–45 shots —
that's fine. Don't fake scene breaks just to keep shot counts low;
the downstream renderer chunks long scenes automatically.

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
      "scene": 1,
      "shotNumber": 1,
      "duration": integer seconds,
      "description": "1–2 sentences: who/what is on camera, the action",
      "cameraWork": "1 sentence: framing + camera motion (e.g. 'medium close-up, slow push-in')",
      "mainSubject": "primary character id OR setting id this shot focuses on",
      "dialogue": "the verbatim spoken line for this shot, OR null if no one speaks",
      "speaker": "character id of the speaker, OR null if dialogue is null"
    }
  ]
}

**Dialogue distribution — critical.** Read the story carefully and
locate every quoted spoken line. Assign each line to exactly ONE
shot — the shot in which that character is on camera speaking that
line. Split long exchanges across consecutive shots (one shot per
character turn). Shots without dialogue use `"dialogue": null,
"speaker": null`. NEVER summarize multiple lines into one shot, and
NEVER fabricate dialogue that wasn't in the source story.

A shot with dialogue should be just long enough to read the line
naturally — roughly 1 second per 3 words, minimum 3s, maximum 8s.

**Shot vocabulary** — vary framing across the sequence. Use shot
types from this palette and write the chosen type into `cameraWork`:
extreme_wide, wide, medium, medium_close_up, close_up, extreme_close_up,
over_the_shoulder, two_shot, point_of_view, insert, cutaway, tracking,
dutch. Don't use the same framing two shots in a row when avoidable.

Hard rules: sum of all shot durations == {{targetDuration}}. Set
`scene` to the scene number this shot belongs to and number shots
within each scene from 1 in `shotNumber` — do NOT emit a shot `id`;
the system constructs it from `scene` + `shotNumber`. Output ONLY the
JSON.
