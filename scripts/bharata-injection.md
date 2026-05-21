## BHARATA FRAMEWORK CONSTRAINTS — REQUIRED ADDITION

This section is APPENDED to the guide above. Treat it as a hard requirement, not optional flavor. Every field below must appear in the output JSON exactly as specified.

### Scene-level required fields

Before listing shots, classify this scene by emotional and structural type. Add these top-level fields to the scene_shot_plan JSON.

- **rasa** (REQUIRED, one of nine): `shringara` (love/beauty), `hasya` (mirth), `karuna` (sorrow/compassion), `raudra` (anger/fury), `veera` (heroic resolve), `bhayanaka` (fear/dread), `bibhatsa` (revulsion), `adbhuta` (wonder/awe), `shanta` (peace/stillness).
  - The dominant emotional aesthetic of this scene. Pick exactly ONE based on the scene description.

- **narrativeMode** (REQUIRED, one of four): `vignette` (single beat, no full arc, sustains one rasa), `compressed_arc` (3-joint micro-story), `full_arc` (5-joint complete story; needs >90s), `mood` (pure rasa exposition).
  - For a single 60-second scene that holds one beat, choose `vignette`.

- **sthayi** (OPTIONAL): the protagonist's persistent emotional substrate during this scene. Pick from: `rati` (love), `utsaha` (heroic resolve), `krodha` (anger), `bhaya` (fear), `soka` (grief), `hasa` (mirth), `vismaya` (wonder), `jugupsa` (disgust), `sama` (calm).

### Rasa-driven pacing & purpose bias

Use the rasa you declared to bias shot duration and purpose distribution. This is the framework's main steering mechanism — do NOT freelance pacing when a rasa prescription exists.

| Rasa | Default shot duration | Purpose mix bias (favor these) | Avoid (relative to other rasas) |
|---|---|---|---|
| `shanta` | 5–8s (long holds) | hold_emotion, set_the_mood, show_reaction | show_action, punctuate |
| `karuna` | 5–7s (linger) | show_reaction, hold_emotion, show_clue | show_action |
| `bhayanaka` | 3–4s (short cuts; tension builds via density) | show_tension, show_clue, show_reaction, punctuate | hold_emotion (too long = relief) |
| `raudra` | 3–4s | show_action, punctuate, show_tension | hold_emotion |
| `veera` | mixed: 3–4s action / 6–8s resolve | show_action, hold_emotion (on resolve), meet_character | set_the_world |
| `adbhuta` | 5–7s | set_the_world, show_change, show_clue | show_action |
| `shringara` | 5–7s (soft holds) | meet_character, hold_emotion, show_reaction | show_action, punctuate |
| `hasya` | 3–5s (snappy) | show_action, show_reaction | hold_emotion |
| `bibhatsa` | 4–6s (uncomfortable linger) | show_clue, set_the_mood | meet_character |

Apply the rasa's pacing as the DEFAULT for every shot in this scene unless a beat genuinely demands an override.

### Shot-level optional fields (use deliberately — sparingly)

Tag 1–3 shots per scene that need a precise micro-cue. Do NOT tag every shot.

- **sattvika** — involuntary internal cue visible on the body. Pick from:
  - `vepathu` (trembling), `sveda` (sweat), `stambha` (stillness/paralysis), `romancha` (gooseflesh), `vaivarnya` (pallor or flush), `ashru` (tears).
  - Use when a beat needs an involuntary physical signal — current image gen misses these without explicit tags.

- **drishti** — character gaze direction (only when face is the focal element). Pick from:
  - `sama` (level, direct), `alokita` (sidelong glance), `sachi` (over-shoulder back-look), `nimilita` (half-closed, inward), `unmilita` (wide, alert), `kuncita` (shrinking, fearful), `roudri` (fierce predatory).

- **vyabhichariBhava** — transient emotion flickering against the scene's sthayi. Pick from:
  - `smriti` (memory flash), `cinta` (worry), `sanka` (suspicion), `nirveda` (despair), `harsha` (joy-flash), `autsukya` (longing), `garva` (pride), `glani` (weariness), `lajja` (shame).
  - Use ONLY on shots where the character's micro-emotion shifts. Most shots inherit the scene's sthayi and need no tag.

### Output JSON additions

The scene_shot_plan JSON object must include these new top-level fields:

```
{
  "sceneNumber": ...,
  "sceneTitle": "...",
  "rasa": "...",            // NEW — REQUIRED
  "narrativeMode": "...",   // NEW — REQUIRED
  "sthayi": "...",          // NEW — optional
  "totalDuration": ...,
  "mainSubject": "...",
  "shotPlan": [
    {
      "shotNumber": 1,
      "purpose": "...",
      "duration": ...,
      "oneLineSummary": "...",
      "perspective": "...",
      "continuityRole": "...",
      "sattvika": "...",          // NEW — optional, only when needed
      "drishti": "...",           // NEW — optional, only when face is focal
      "vyabhichariBhava": "..."   // NEW — optional, only on shifts
    }
  ]
}
```

### Bharata-framework checklist (run before output)

1. Did you declare a single `rasa` for the scene? Required.
2. Did you declare `narrativeMode`? Required.
3. Are most shot durations within the rasa's prescribed band (per the table above)? If not, defensible only if you can explain why.
4. Does the shot purpose distribution lean toward the rasa's preferred purposes? Count them.
5. Did you tag sattvika/drishti/vyabhichari ONLY where they earn their place (1–3 shots, not all)?
6. If `narrativeMode` is `vignette`: is the rasa sustained across ALL shots? A vignette should NOT cycle rasas.
