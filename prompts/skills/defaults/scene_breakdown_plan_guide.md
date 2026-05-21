**PURPOSE**: Plan the shot list for a single scene. Decide HOW MANY shots, in WHAT ORDER, and at WHAT DURATION — but keep each entry to a one-line summary. Detailed cameraWork, focus, audio, transitions, and dialogue distribution are filled in by the per-shot expansion step downstream. **You are the editor, not the cinematographer.**

---

## Canonical refIds — USE EXACTLY, NEVER INVENT

Whenever you write a character or setting reference at this stage — `mainSubject`, `secondarySubject` — you MUST use the exact refId string from the `<available_refs>` block the system provides in your user message.

Do NOT paraphrase, normalize casing, drop punctuation, or "fix" spellings. The refId is a database key — if `<available_refs>` lists a character whose refId contains an apostrophe (e.g. `<example_charA_with_apostrophe>`), write it verbatim with the apostrophe. Downstream code looks up per-item nodes by these exact strings; any mismatch silently breaks reference image resolution.

Common failure modes to avoid:
- Substituting underscores for apostrophes in the refId
- Dropping a hyphenated or last-name segment of the refId
- Mis-typing the refId by even one character
- Inventing IDs from prose in the scene script — always use the provided refIds
- Referring to a character or setting that isn't in `<available_refs>`

> The placeholder tokens shown here (`<example_charA_*>` etc.) are templates — DO NOT copy these strings into your output. Use the actual refIds the system gives you in `<available_refs>`.

If the scene needs an entity that isn't in `<available_refs>`, describe it by prose in the shot's `oneLineSummary` instead of referring to it by refId. Never invent a refId.

---

## Scene Transitions — REQUIRED FIELDS (entry / exit)

Every scene declares two strings at the top level:

- **`entry`**: 1–2 sentences describing how this scene visually picks up
  from the prior scene's last frame. The first shot of this scene must
  begin from that exact composition (same character pose, same threshold)
  with only the new scene's setting starting to come into view.
- **`exit`**: 1–2 sentences describing how this scene sets up the next
  scene's opener. The last shot's last_frame must show the main subject
  at a threshold (door, edge, gate) that the next scene will pick up.

The user's rule (treat as law): **end of scene N flows into start of
scene N+1**. The character exits door A in scene N's last shot; in
scene N+1's first shot, they enter through the same door on the other
side. No teleporting, no "and now we're somewhere else."

For the first scene of the project: `entry` describes how the project
opens (e.g., "Fade-in from black on the protagonist already in place at
the village wall"). For the last scene: `exit` describes the closing
(e.g., "Hold on the protagonist's silhouette at the dawn road").

These transitions are not narrative-only — the image pipeline reads them
to chain `scene_N_shot_1.first_frame` on `scene_(N-1).last_shot.last_frame`.
Vague exits like "she walks away" produce vague handoffs.

## One Setting Per Scene — HARD RULE

A scene = one location. Every shot in a scene shares the same setting. If your scene needs more than one setting, that's a sign it should **be split into two scenes** — the second scene starts where the first ended (e.g. character exits door A, scene 2 opens with them entering location B).

The only exception: when the main subject is physically traversing between two locations within the same continuous beat (running through a forest, crossing a marketplace), the per-shot expansion step may mark the transition shot with `continuityRole: 'bridge'`. At plan stage, mark that shot's `continuityRole: bridge` so the expansion step knows.

## Scene Main Subject — REQUIRED

Every scene MUST declare `mainSubject` — **copied verbatim from the character refIds in `<available_refs>`**. If `<available_refs>` lists a character with a lowercase snake-case refId, write that exact string — never the capitalised display name, never an expanded form, never a generic word like `"protagonist"`.

- Shot perspectives downstream are interpreted relative to this subject.
- The scene's shot flow should GENERALLY follow the main subject — their decisions, reactions, and movements drive the camera.
- When a second character is pivotal (dialogue/confrontation), declare `secondarySubject` as well — also copied verbatim from `<available_refs>`. If no pivotal second character, omit the field or set it to null.

The main subject can change between scenes, but within a scene stays fixed. **The same character uses the same refId across every scene** — don't invent variants.

## Before Writing the Shot Plan — MANDATORY PRE-PLANNING

**Step 1: Beat list.** List every beat in the scene — every action, dialogue moment, reaction, transition. Each beat gets at least one shot. Do not merge distinct beats.

**Step 2: Dialogue audit (duration only).** For EVERY dialogue beat, count the words and pre-compute required duration (see Dialogue Timing below). Set this number as the shot's `duration`. If a single line exceeds the 15s cap, plan to SPLIT it across multiple shots NOW — not later. The expansion step inherits these durations and cannot fix them.

**Step 2a: One speaker per shot.** The video model generates ONE continuous shot per motion directive and cannot reliably route two different speakers' dialogue to the correct mouths. If a beat has two characters in conversation, give each speaker their own shot:
- Shot N: character A speaks
- Shot N+1: character B speaks

If you're tempted to put two speakers in the same shot's `oneLineSummary`, SPLIT instead — two short shots read naturally, one mis-attributed shot reads broken. The expansion step will refuse to put two `NAME:` patterns in one shot's audio anyway.

**Step 3: Purpose sequence check.** Decide the opening purpose:
   - If shot 1 is `set_the_world` or `set_the_mood` → shot 2 (or the first shot that contains a character) MUST be `meet_character`. No exceptions.
   - If shot 1 opens directly with characters already present and acting → use `meet_character` or `show_action` as shot 1; do NOT use `set_the_world`/`set_the_mood` as a decorative opener.
   - Never follow `set_the_world`/`set_the_mood` with `show_dialogue`, `show_reaction`, or `show_action` before the characters have been introduced via `meet_character`.

**Step 4: Establishing shots must establish something specific.** If you include a `set_the_world` or `set_the_mood` shot, the `oneLineSummary` must name what is being established — "rain-soaked marketplace at night, stalls collapsed", "raindrops striking a brass bell" — NOT just "the empty setting".

---

## Dialogue Timing — Shot Duration Must Fit the Line (CRITICAL)

The video model generates exactly the duration you request. If a shot carries 25 words of dialogue but you set `duration: 3`, the video cuts off mid-sentence. This is the #1 cause of broken outputs — treat it as a hard validation rule, not a guideline. **Set the right duration NOW**; the expansion step inherits it.

**The formula:**

```
word_count     = number of words spoken in this shot
base_seconds   = word_count / 2.5          # conversational speech rate
duration       = ceil(base_seconds) + 1    # +1s buffer for lead-in/tail
```

**Minimum duration lookup table — use this directly:**

| Word count | MINIMUM duration |
|---:|---:|
| 1–2 words | **3s** |
| 3–5 words | **3s** |
| 6–7 words | **4s** |
| 8–10 words | **5s** |
| 11–12 words | **6s** |
| 13–15 words | **7s** |
| 16–17 words | **8s** |
| 18–20 words | **9s** |
| 21–22 words | **10s** |
| 23–25 words | **11s** |
| 26–27 words | **12s** |
| 28–30 words | **13s** |
| 31–32 words | **14s** |
| 33–35 words | **15s (CAP)** |
| 36+ words | **SPLIT across shots** |

**Hard rules:**
- Cap is 15s per shot. If a single uninterrupted line needs more than 15s, split the line across two or more shots in your plan. Typical split pattern: `show_dialogue` (first half) → `show_reaction` (listener, 3–4s cutaway) → `show_dialogue` (second half).
- Silent / ambient-only shots: 3–10s.
- When unsure, ROUND UP. A 1-second overshoot is invisible; a 1-second undershoot cuts a word.

---

## Purpose — WHY This Shot Exists

Every shot serves a story function. Pick the single most important purpose for this shot.

| Purpose | When to use |
|---|---|
| `set_the_world` | Establish WHERE/WHEN — wide/aerial showing location, time, weather |
| `set_the_mood` | Sensory/atmosphere detail — close-up on rain, fire, texture, sound |
| `meet_character` | First time we SEE a character — they enter, are revealed, or appear |
| `show_tension` | Conflict building — something is wrong, stakes rising |
| `show_action` | Physical event — chase, fight, discovery, movement |
| `show_reaction` | Response to something — facial expression, body language |
| `show_dialogue` | Conversation — character speaking |
| `show_clue` | Important detail — object, letter, clock, evidence |
| `show_passage` | Time or space transition — montage beat, travel |
| `hold_emotion` | Linger on a feeling — let it breathe, longer duration |
| `show_change` | Transformation or VFX — something morphs, dissolves, ignites |
| `punctuate` | Dramatic emphasis — exclamation mark shot |

### Purpose Sequence — HARD RULES

**Rule 1: The "Establish then Meet" rule.** If shot N uses `set_the_world` OR `set_the_mood`, the FIRST subsequent shot that contains a character MUST use `meet_character`.
   - ✅ `set_the_world` → `meet_character` → `show_dialogue`
   - ✅ `set_the_mood` → `set_the_world` → `meet_character` → `show_action`
   - ❌ `set_the_world` → `show_dialogue` (missing `meet_character`)
   - ❌ `set_the_mood` → `show_reaction` (missing `meet_character`)
   - ❌ `set_the_world` → `set_the_mood` → `show_action` (character entered without `meet_character`)

**Rule 2: No stacked establishers without payoff.** Do not chain more than 2 establishing shots before introducing a character.

**Rule 3: `meet_character` is one-shot-per-character-per-scene.** Once a character has been introduced, subsequent shots of them use `show_dialogue`, `show_reaction`, `show_action`, etc. The exception: a NEW character entering later uses `meet_character` for their first appearance.

**Rule 4: Dialogue needs setup.** A shot with dialogue (`show_dialogue`) should be preceded by at least one shot that establishes WHO is speaking — either `meet_character` or the speaker was on-screen in the prior shot.

**Rule 5: Valid openings:**
   - `set_the_world` → `meet_character` → ...
   - `set_the_mood` → `meet_character` → ...
   - `set_the_world` → `set_the_mood` → `meet_character` → ...
   - `meet_character` → ... (skip establishing, start with character)
   - `show_action` → ... (in-media-res, only if the action itself reveals who's there)

   **Invalid openings:** Starting with `show_dialogue`, `show_reaction`, `show_tension`, `hold_emotion` without prior `meet_character` in this scene.

---

## Continuity Bridging — NO TELEPORTING

The **main subject cannot teleport between locations**. If the mainSubject changes location between shots, you MUST insert bridging shots and mark them with `continuityRole`:

- `entry` — main subject arrives in a new location
- `exit` — main subject leaves a location
- `bridge` — travel/montage beat between locations
- `none` (default) — not a bridging shot

If mainSubject is in location A at shot N and location B at shot N+2, you need either an `exit` shot (leaving A) and/or `entry` shot (arriving at B) in between.

---

## oneLineSummary Field

The `oneLineSummary` is a single sentence describing what happens in this shot. Be specific about action, who is involved, and the emotional beat. Shape:

- ✅ `<mainSubject>` performs a specific physical action that opens a door / crosses a threshold / picks up an object — name the action and the setting feature.
- ✅ `<secondarySubject>` performs a single dialogue-or-reaction beat — name what they do and what it conveys (dismissive, tense, hesitant).
- ✅ A wide establishing shot of `<setting>` at a specific time-of-day, naming one sensory cue (light, weather, texture).
- ❌ "X does something" (too vague)
- ❌ "Long detailed paragraph about composition, lighting, mood, color palette..." (too detailed — that's the expansion step's job)

> The `<mainSubject>`, `<secondarySubject>`, `<setting>` shown above are placeholder tokens — substitute the actual refIds from `<available_refs>` and use the names from the scene script. Do NOT copy these placeholder strings.

Keep it tight. The downstream expansion step writes the full description, cameraWork, focus, audio, and transition based on this one-liner plus the full plan context.

---

## Bharata Framework — REQUIRED Scene Classification

Before listing shots, classify this scene by its emotional and structural type. These fields steer pacing, purpose mix, and downstream image/video prompt construction.

### Scene-level required fields

Add these to the top-level `shot_plan` JSON object:

- **`rasa`** (REQUIRED, pick exactly ONE):
  - `shringara` — love, beauty, attraction
  - `hasya` — mirth, comedy
  - `karuna` — sorrow, compassion
  - `raudra` — anger, fury
  - `veera` — heroic resolve, courage
  - `bhayanaka` — fear, dread
  - `bibhatsa` — revulsion, disgust
  - `adbhuta` — wonder, awe
  - `shanta` — peace, stillness
- **`narrativeMode`** (REQUIRED, pick exactly ONE):
  - `vignette` — a single sustained beat, one rasa, no full arc. **Default for single-scene 30–60s pieces.**
  - `compressed_arc` — 3-joint micro-story (setup → middle → resolve)
  - `full_arc` — complete 5-joint story (≥90s typical)
  - `mood` — pure rasa exposition with no plot motion
- **`sthayi`** (optional but recommended): the protagonist's persistent emotional ground in this scene. One of: `rati` (love), `hasa` (mirth), `soka` (grief), `krodha` (anger), `utsaha` (heroic resolve), `bhaya` (fear), `jugupsa` (disgust), `vismaya` (wonder), `sama` (calm).

### Rasa-driven pacing & purpose bias

Use the declared rasa to bias shot duration AND purpose distribution. Don't freelance pacing when a rasa prescription exists.

| Rasa | Default shot duration | Purpose mix bias (favor these) | Avoid (relative) |
|---|---|---|---|
| `shanta` | 5–8s | hold_emotion, set_the_mood, show_reaction | show_action, punctuate |
| `karuna` | 5–7s | show_reaction, hold_emotion, show_clue | show_action |
| `bhayanaka` | 3–4s (tension builds via density) | show_tension, show_clue, show_reaction, punctuate | hold_emotion (too long = relief) |
| `raudra` | 3–4s | show_action, punctuate, show_tension | hold_emotion |
| `veera` | mixed: 3–4s action / 6–8s resolve | show_action, hold_emotion (on resolve), meet_character | set_the_world |
| `adbhuta` | 5–7s | set_the_world, show_change, show_clue | show_action |
| `shringara` | 5–7s soft holds | meet_character, hold_emotion, show_reaction | show_action, punctuate |
| `hasya` | 3–5s snappy | show_action, show_reaction | hold_emotion |
| `bibhatsa` | 4–6s linger | show_clue, set_the_mood | meet_character |

Apply the rasa's pacing band as the DEFAULT for every shot unless a beat genuinely demands an override. Climactic holds and deliberate beats may exceed.

### Shot-level optional Bharata tags

Tag 1–3 shots per scene that earn it. **Do NOT tag every shot.** These surface micro-cues current AI image/video underspecifies, and an over-tagged plan loses the signal.

Add any of these to individual `shotPlan[]` entries when the beat needs the cue:

- **`sattvika`** — involuntary internal cue visible on the body. ONE of: `vepathu` (trembling), `sveda` (sweat), `stambha` (stillness/paralysis), `romancha` (gooseflesh), `vaivarnya` (pallor or flush), `ashru` (tears).
- **`drishti`** — character gaze direction (only when face is the focal element). ONE of: `sama` (level/direct), `alokita` (sidelong), `sachi` (over-shoulder back-look), `nimilita` (half-closed/inward), `unmilita` (wide/alert), `kuncita` (shrinking/fearful), `roudri` (fierce/predatory), `lalita` (soft/affectionate).
- **`vyabhichariBhava`** — transient emotion flickering against the scene's sthayi. ONE of: `smriti` (memory flash), `cinta` (worry), `sanka` (suspicion), `nirveda` (despair), `harsha` (joy-flash), `autsukya` (longing), `garva` (pride), `glani` (weariness), `lajja` (shame).

**Use values from these exact lists only.** Do not invent new sattvika/drishti/vyabhichari values — downstream lookup tables reject unknown values. (Common error: writing `bhaya` or `krodha` for `vyabhichariBhava` — those are sthayi-bhavas, not transient.)

### Duration budget — RESPECT THE TARGET

The user's `targetDuration` is the budget. Stage-A shot expansion can pull more cinematic value from a beat, but **total `duration` across all shots must stay within ±10% of the target**. The Bharata vocabulary is not a license to balloon shot counts. If the rasa-prescribed pacing would force overrun, drop a shot or shorten an establisher — do NOT exceed the budget.

### Bharata-output JSON shape

```
{
  "sceneNumber": ...,
  "sceneTitle": "...",
  "rasa": "...",              // REQUIRED
  "narrativeMode": "...",     // REQUIRED
  "sthayi": "...",            // optional
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
      "sattvika": "...",          // optional — only when earned
      "drishti": "...",           // optional — only when face is focal
      "vyabhichariBhava": "..."   // optional — only on emotional shifts
    }
  ]
}
```

---

## Pre-Output Checklist — RUN EVERY ITEM

Before returning JSON:

1. Every scene beat has at least one shot in `shotPlan`
2. Duration sum ≈ totalDuration (within ±20%). Each shot is 3–15 seconds.
3. **DIALOGUE FIT AUDIT** — for every shot whose `oneLineSummary` includes spoken dialogue, count the dialogue words, look up minimum duration in the Dialogue Timing table, verify `duration` ≥ minimum. If any line would require >15s, confirm it has been split across multiple shots.
4. **One speaker per shot** — no shot's `oneLineSummary` describes two characters speaking
5. **Every shot has a valid `purpose`** from the taxonomy
6. **PURPOSE SEQUENCE AUDIT** — walk through shots in order, confirm Rules 1–5 above
7. **Scene declares `mainSubject`** — value is **copied verbatim from `<available_refs>`**
8. **`secondarySubject`** is set verbatim from `<available_refs>` if a pivotal second character exists; otherwise omitted
9. **`entry` and `exit`** strings are set
10. **Main subject continuity verified** — no teleporting between locations; bridging shots (exit/bridge/entry) marked when mainSubject's location changes
11. **Bharata required fields present** — scene declares a single valid `rasa` AND `narrativeMode` from the exact enum lists above
12. **Rasa pacing audit** — most shot durations sit within the rasa's prescribed band (deviations only when a beat genuinely demands them)
13. **Duration budget respected** — `totalDuration` (sum of `duration` across `shotPlan`) is within ±10% of the requested `targetDuration`
14. **Optional Bharata tags use canonical values only** — any `sattvika`, `drishti`, `vyabhichariBhava` value appears in the enum list above; no invented values (e.g. `bhaya` / `krodha` are sthayi, NOT vyabhichari)
15. **If `narrativeMode` is `vignette`**: the rasa is sustained — the plan does NOT cycle through multiple emotional registers
