# Dhee Core (`dhee-core` package)

An AI video generation engine. Give it a story idea; it produces a finished video — screenplay, characters, shots, keyframes, video clips, and final assembly with transitions.

This repository is the headless engine (npm package **`dhee-core`**). It runs as a CLI, an embedded library, or an HTTP/WebSocket server. It also powers [`dhee-desktop`](https://github.com/dheeai/dhee-desktop) (the Electron app), which embeds it in-process for the local-mode experience.

## What it does

Given free text, the engine walks a dependency graph end-to-end:

1. **Story essence** — extracts genre, throughline, tonal notes (an action thriller and an emotional drama produce structurally different scenes from the same pipeline).
2. **Scene extraction** — Stage A summaries → parallel Stage B beats. Hierarchical so long stories don't blow context.
3. **Screenplay** — duration-scaled. A 30-second video gets 2-3 characters and 2 scenes; a 3-minute video gets more.
4. **World style bible** — color palette, lighting, atmosphere — used as a reference dependency by every image prompt that follows.
5. **Character & setting reference images** — generated against the style bible so a character looks the same in every shot.
6. **Per-shot prompts** — slim 6-field JSON per shot (description, cameraWork, audio, transition, duration, shotNumber) with character-state tracking across shots (no teleportation, no continuity errors).
7. **Keyframes** — first / first+last / first+mid+last frames, strategy chosen per shot.
8. **Shot videos** — image-to-video, text-to-video, FLFV, or FMLFV via the active workflow.
9. **Final assembly** — FFmpeg concat with xfade transitions, resolution scaling, interleaved audio.
10. **Optional fidelity audit** — VLM judge (calibrated to ≥80% per-question agreement with Claude) scores every keyframe against its prompt.

## Architecture

A single `ExecutorAgent` walks a dependency graph. Each node is one LLM or media-generation call routed through a provider registry. The agent generates content; the executor handles dependencies, retries (exponential backoff, 3-attempt cap), persistence, and cascade invalidation.

That inversion is the point — most agentic video tools ask the LLM to navigate its own state machine and break the moment the LLM drifts. Here the code drives the pipeline and the LLM is just a content generator. You get deterministic resumability, deterministic retries, and a clean contract for external drivers.

```
src/
├── core/                  Executor, dependency graph, providers, prompts
├── agent/pi/              Headless adapter for external agents (pi-agent)
├── tasks/                 Per-template pipelines (narrative, doc, short, …)
├── server/                HTTP + WebSocket API, ConversationManager, runners
├── services/              Workflow registry, asset store, fidelity judge
├── templates/             Video-template definitions (graph + prompts)
└── testing/               Eval harness, calibration helpers
```

## Providers

Every capability (image gen, image edit, video gen, LLM) selects a provider independently:

| Capability | Providers wired |
|-----------|-----------------|
| LLM | OpenRouter, Gemini, OpenAI, LM Studio, any OpenAI-compatible endpoint |
| Image generation | ComfyUI (local + Cloud), Google Imagen, xAI Grok |
| Image editing | ComfyUI (FLUX 2 Klein, Qwen-Edit), xAI Grok |
| Video generation | ComfyUI (LTX 2.3 i2v / FLFV / FMLFV), Google Veo |

Workflows are user-uploadable — both ComfyUI LiteGraph and API formats are auto-detected, inputs are introspected, LoRA trigger keywords are injected, and AnythingEverywhere implicit connections are resolved.

## Installation

```bash
git clone <repo>
cd dhee-core
pnpm install
cp .env.example .env
# Edit .env, then:
pnpm start
```

`pnpm start` builds the React frontend and runs the HTTP/WebSocket server at `http://127.0.0.1:3000` by default. Open the URL to use the web UI; or drive it from `dhee-desktop`, `pi-agent`, or any HTTP client.

Requirements:
- Node ≥ 20
- `ffmpeg` on `PATH`
- A ComfyUI endpoint (local or `cloud.comfy.org`) for image/video generation
- An LLM provider (Gemini API key, OpenRouter key, or a local LM Studio)

## Environment

The full set lives in `.env.example`. Common configurations:

**OpenRouter LLM + Comfy Cloud:**
```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=...
OPENAI_MODEL=x-ai/grok-4.1-fast
COMFYUI_BASE_URL=https://cloud.comfy.org
COMFY_CLOUD_API_KEY=...
```

**Local ComfyUI + LM Studio:**
```bash
LLM_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_MODEL=qwen3
COMFYUI_BASE_URL=http://localhost:8188
```

When `COMFYUI_BASE_URL` is `https://cloud.comfy.org`, the engine switches to Cloud API routes and requires `COMFY_CLOUD_API_KEY`. Anything else stays on local/self-hosted behavior.

## CLI scripts

```bash
pnpm start                  # Run the server (web UI + API)
pnpm dev                    # Server with watch mode
pnpm new <name>             # Create a new project
pnpm run-to <project> <stage>   # Run pipeline up to a specific stage
pnpm reset <project> <stage>    # Reset a project back to a stage
pnpm regen <project> <node>     # Regenerate one node and its downstream
pnpm override <project> <node>  # Replace a node's content with your own
pnpm status <project>       # Project status
pnpm inspect <project>      # Inspect project graph + content
pnpm nodes <project>        # List all nodes
pnpm stop                   # Stop the running executor
pnpm audit-fidelity <project>   # VLM keyframe fidelity report
pnpm calibrate-vlm          # Calibrate the VLM judge against Claude
pnpm test                   # Vitest unit tests
pnpm test:e2e               # End-to-end tests
pnpm build                  # Production build
pnpm lint                   # tsc --noEmit && eslint
```

## API

All endpoints under `/api/v1`. WebSocket at `/api/v1/ws/chat` for streaming.

**Health & sessions**
- `GET /health`
- `GET /sessions`, `DELETE /sessions/:id`

**Providers & workflows**
- `GET/POST /providers` — read or update per-capability provider selection
- `GET /workflows`, `POST /workflows` (upload), `POST /workflows/:id/test`, `POST /workflows/:id/activate`, `DELETE /workflows/:id`

**Project control (for external agents)**
- `POST /projects/:name/run-to` — run pipeline to a stage
- `POST /projects/:name/stop`
- `GET  /projects/:name/status`
- `GET  /projects/:name/nodes/:alias`
- `POST /projects/:name/regen` — regenerate node + downstream
- `POST /projects/:name/override` — replace node content

**Assets**
- `GET /assets/:project/:path`

On launch the server writes `~/.dhee/server.json` (mode 0600) with its URL, port, and pid so external drivers can find a desktop-launched core without knowing its random port.

## Project format

Every project is a self-contained directory: `<name>.dhee/`. Inside:

```
project.json        Graph state, node statuses, content, manifests
prompts/            Persisted LLM outputs (story_essence.json, …)
images/             Character refs, setting refs, keyframes
videos/             Per-shot clips and final assembly
timeline.json       Segment ordering and transitions
logs/               Per-phase + executor logs
```

State survives server restarts. Reconnect and the executor picks up exactly where it stopped.

## Templates

Five built-in video templates:

- **Narrative** — full cinematic story-to-video pipeline
- **Documentary** — thesis → outline with sources → segment visuals
- **YouTube Shorts** — hook-first vertical short-form
- **Infomercial** — value prop → demo script → product visuals
- **Graphic Novel** — illustrated panels for graphic-novel layout

Five visual styles: Cinematic Realism, Anime, Stylized 3D, Watercolor, Custom.

## Testing & evals

```bash
pnpm test                 # Vitest unit suite
pnpm test:e2e             # Server + executor E2E
pnpm test:coverage        # Coverage report
pnpm eval                 # Run prompt evals (live LLM)
pnpm eval:mock            # Run prompt evals (mocked)
pnpm audit-fidelity <p>   # VLM-judged fidelity report for a project
```

Calibrated VLM judging means regressions are visible. Without measurement, "did the AI make the right thing?" is gut feel.

## License

[GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0).

If you run a modified version of `dhee-core` as a network service, AGPL requires you to make the complete corresponding source available to users of that service. See `LICENSE` for the full terms.
