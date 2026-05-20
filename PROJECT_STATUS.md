# dhee - Project Progress Report

## What is dhee?

dhee is a **CLI-based AI video generation pipeline** that transforms text stories into fully produced videos through an automated 8-phase workflow.

### The Problem

Creating video content from scratch requires juggling multiple disconnected AI tools:

- ChatGPT for writing scripts
- Midjourney/DALL-E for images
- Runway/Pika for video generation
- Manual editing to stitch everything together

The result: hours of manual orchestration, inconsistent characters across scenes, and a fragmented workflow that kills creative momentum.

### The Solution

dhee orchestrates the entire pipeline automatically:

**Input**: A text story or idea (e.g., "A boy wakes up alone on a mysterious island...")

**Output**: A complete video with consistent characters and settings

### The 8-Phase Pipeline

1. **Plot Development** - Structure the story arc
2. **Story Writing** - Full narrative with detail
3. **Characters & Settings** - Detailed profiles with visual descriptions
4. **Scene Breakdown** - Individual scenes with camera/action notes
5. **Reference Images** - Generate consistent character/setting visuals
6. **Scene Images** - Generate each scene using references for consistency
7. **Video Generation** - Animate each scene image
8. **Final Stitching** - Combine into single output video

### Key Features

- **Human-in-the-loop**: Approve or regenerate at each phase
- **Visual consistency**: Reference images keep characters looking the same
- **Resumable**: Project state saves automatically, pick up where you left off
- **Self-hosted**: Uses local ComfyUI, no per-image API costs

---

## Current Stage

**Late Prototype / Early Alpha**

The core pipeline is functional and generating real video output. Active daily development.

### What's Working

- All 8 phases implemented and functional
- ComfyUI integration (ZImage, Qwen Edit Lightning, WAN Video)
- Project state persistence in `.dhee/project.json`
- Per-item approval workflow
- Reference-based scene generation for character consistency
- Real-time streaming display in CLI
- Clean terminal output (no debug noise)

### What's Not Ready Yet

- No web UI (CLI only)
- Limited error recovery
- Single-user local deployment only
- No audio/voiceover integration yet

---

## Recent Progress

### This Week

- Implemented tool streaming (see AI generating content in real-time)
- Fixed scroll jumping and text selection in CLI
- Added phase-specific instructions for image/video generation phases
- Switched to Qwen Edit Lightning (3x faster image generation)
- Cleaned up all debug logging
- Fixed project state persistence bug for scene images phase

### Previous Weeks

- Integrated WAN 2.2 Lightning for video generation
- Built ComfyUI workflow parameterization system
- Implemented 8-phase state machine with planner stages
- Added per-item approval for characters, settings, and scenes
- Created reference image consistency system

### Sample Output Generated

- 3-scene video: "A boy waking up on a mysterious island"
- Consistent character appearance across all scenes
- Each scene animates with motion from static image

---

## Technical Stack

| Component | Technology |
|-----------|------------|
| CLI Interface | React Ink (TypeScript) |
| LLM Backend | LM Studio |
| Image Generation | ComfyUI (ZImage, Qwen Edit) |
| Video Generation | ComfyUI (WAN 2.2 Lightning) |
| State Management | JSON file persistence |
| Build System | tsup |

---

## Next Steps

### Immediate (Next 2-4 Weeks)

1. Improve image consistency with better prompt engineering
2. Add audio/voiceover integration (TTS)
3. Better error handling and recovery

### Short-Term (1-3 Months)

1. Cloud deployment option (RunPod/Modal)
2. Web UI MVP
3. Template library for common story types
4. Quality vs speed presets

### Long-Term (2026)

1. Multi-user support
2. Public beta
3. API for programmatic access

---

## Infrastructure

- **Development**: Local MacOS
- **ComfyUI**: Running on cloud GPU (ngrok tunnel)
- **Monthly Cost**: ~$50-100 for GPU compute
- **No external APIs**: Self-hosted image/video generation

---

## Repository Structure

```
dhee-core/
├── src/
│   ├── App.tsx                 # Main CLI application
│   ├── components/             # React Ink UI components
│   ├── core/                   # Agent system, tools, LLM client
│   ├── hooks/                  # React hooks (useAgent, etc.)
│   ├── services/comfyui/       # ComfyUI integration
│   └── tasks/video/            # Video generation workflow
│       └── workflow/           # 8-phase state machine
├── prompts/workflow/           # Phase-specific prompts
├── workflows/                  # ComfyUI workflow JSON files
└── .dhee/                    # Project data (created per-project)
    ├── project.json            # Project state
    ├── plans/                  # Generated plans (plot, story, etc.)
    ├── characters/             # Character profiles
    ├── settings/               # Setting profiles
    └── assets/                 # Generated images and videos
```

---

## Metrics

| Metric | Value |
|--------|-------|
| Lines of Code | ~15,000 |
| ComfyUI Workflows | 3 (ZImage, Qwen Edit, WAN Video) |
| Workflow Phases | 8 |
| Avg Image Gen Time | ~15s (Lightning) |
| Avg Video Gen Time | ~60s |

---

*Last Updated: December 2025*
