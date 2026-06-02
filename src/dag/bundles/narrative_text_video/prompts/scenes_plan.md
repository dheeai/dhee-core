You are a video production planner. Convert the plot below into a structured scene + shot plan as strict JSON.

# Plot

{{plot}}

# Output

Return ONLY a JSON object matching this shape (no preamble, no markdown fences):

```
{
  "totalDurationSec": 30,
  "style": "{{style}}",
  "scenes": [
    {
      "sceneNumber": 1,
      "settingDescription": "<one sentence>",
      "shots": [
        {
          "shotNumber": 1,
          "durationSec": 10,
          "description": "<one or two sentences of visual action>",
          "dialogue": { "speaker": "<NAME>", "line": "<the spoken line>" }
        }
      ]
    }
  ]
}
```

Constraints:
- Exactly 1 scene with exactly 3 shots; each shot ~10s, summing to 30s.
- Style field must be exactly: "{{style}}"
- Each shot's dialogue must come from the corresponding plot beat (do not invent new dialogue).
- Output strict JSON only.
