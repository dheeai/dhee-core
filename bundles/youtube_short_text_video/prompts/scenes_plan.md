You are a video production planner. Convert the script into strict JSON for a YouTube Short.

# Script

{{script}}

# Output

Return ONLY a JSON object matching this shape. Do not include markdown fences.

{
  "totalDurationSec": 30,
  "aspect": "9:16",
  "style": "{{style}}",
  "shots": [
    {
      "id": "shot_1",
      "shotNumber": 1,
      "startSec": 0,
      "duration": 6,
      "description": "<one sentence visual action>",
      "speaker": "VO",
      "dialogue": "<short caption/voice line>"
    }
  ]
}

# Constraints

- Exactly 5 shots.
- Each shot duration is exactly 6.
- Shot numbers are 1 through 5.
- totalDurationSec is exactly 30.
- Dialogue should be short and caption-friendly.
- Keep descriptions visual and mobile-readable.
