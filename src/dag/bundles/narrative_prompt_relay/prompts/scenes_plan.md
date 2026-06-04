You are breaking a short cinematic story into scenes and shots.

Story:
{{story}}

Story essence:
{{story_essence}}

Settings (the ONLY locations available — every `settingId` you emit MUST be one of these exact ids):
{{settings_plan}}

Target duration: {{targetDuration}} seconds total.

A scene is a contiguous unit in one location/setting. A shot is a
single camera setup within a scene. Each shot has a fixed duration
(use clean integers, sum across all shots must equal the target
duration). Most shots should be 3–6 seconds.

**Scene count — DO THIS FIRST, before writing any shots.** Look at the
`Settings` list above and walk the story in order, noting each time the
camera moves to a DIFFERENT location. Your `scenes` array length MUST
equal the number of distinct location visits — nothing else determines
it. (A location the camera leaves and returns to counts each time it
returns.)

A new scene is created ONLY by a location change. It is NOT created by:
a new character entering, a new action, a new story beat, or a shift in
`narrativeMode`. `narrativeMode` (setup/rising/climax/resolution) is a
LABEL for a scene's role — NEVER a reason to split. If the entire story
unfolds in ONE location, it is ONE scene with many shots, no matter how
many characters act or how much happens — even at 180s. The downstream
renderer chunks a long single-location scene into clips automatically;
do NOT pre-split it into beats.

Examples:

  - Entire story under one tree — many characters, attempts, a climax →
    ONE scene (one location), with as many shots as the duration needs.
  - Room → cutaway to cubicle → back to room → 3 scenes (scene_1=room,
    scene_2=cubicle, scene_3=room again; scenes 1 and 3 reuse the same
    settingId because the camera left and returned).
  - Room → end montage of 4 intercut locations → 1 main scene + 1
    montage scene (the rapid-cut montage is conceptually one beat).

A typical short film is 1–4 scenes. Setting reuse is fine.

Within a scene, use however many shots you need to fill the time at
3–6s each. A 180-second one-room scene is roughly 30–45 shots —
that's fine. Don't fake scene breaks just to keep shot counts low;
the downstream renderer chunks long scenes automatically.

**Shot pacing (LTX-2 constraint).** LTX-2 renders slow-to-moderate
motion beautifully and struggles with fast action (multi-limb rapid
movement, sword fights mid-swing, car chases). Each shot should
capture ONE deliberate motion or held moment — not a frantic
sequence. If the plot calls for a fight or chase, **break it into
many short shots, one action per shot** (hand grips weapon → arm
arcs back → blade meets armor) rather than one "they fight" shot.
Tension reads as fast through cutting, not through cramming fast
motion into a single shot. The 3-6s shot budget already encourages
this; lean into it.

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
      "id": "scene_1_shot_1",
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

Hard rules: sum of all shot durations == {{targetDuration}}. shot.id
format is exactly "scene_N_shot_M". Output ONLY the JSON.
