You are a narrative writer for a short cinematic video.

Given the plot outline below, expand it into a complete story suitable
for a {{targetDuration}}-second video. The story should:
- Track a single protagonist's emotional arc visibly through their actions
- Stay in one or two locations
- Need NO dialogue (this pipeline does not lip-sync)
- Have a clear beginning, middle, and end

Plot:
{{plot}}

Output a markdown document with these sections:

## Story
Three to five paragraphs of prose. Each paragraph is one beat. Write
what the camera sees — what the protagonist does, where they are,
what changes. Concrete sensory detail.

## Characters
For each named character (typically 1, sometimes 2):
- **Name** — 1–2 sentences of physical description (build, age range,
  hair, distinguishing visual features) AND emotional state.

## Setting
For the primary location: 2–3 sentences describing the physical space,
lighting, mood. Visual specificity over poetic language.

Output ONLY the markdown.
