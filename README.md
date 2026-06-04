# Dhee Core (`dhee-core` package)

The headless engine behind **dhee** — a local-first generative-media studio. Give it a story idea and it produces a finished video: screenplay, characters, shots, keyframes, clips, and a final cut with transitions. Everything runs on your machine.

`dhee-core` is a headless TypeScript engine (npm package **`dhee-core`**). It is embedded in-process by [`dhee-desktop`](https://github.com/dheeai/dhee-desktop) (the Electron app), driven by an in-process agent, and importable as a library. There is no SaaS backend and no separate server to run — the agent, the engine, and the UI host all live in one process.

## How it works

You don't navigate the pipeline by hand. An agent (branded **dhee**; the reference driver lives in `src/agent/pi/`) runs a **bundle** — a versioned DAG of LLM and media-generation steps — against a project directory. The agent picks the bundle that fits, fills its inputs, kicks off the run, and inspects or regenerates individual nodes on your behalf.

Each run is **event-sourced**: an append-only event log (`<project>/.dhee/events.jsonl`) is the source of truth, and everything else — the node graph in `project.json`, costs, versions, branches — is a projection of that log. That's what makes runs resumable after a crash, cheap to re-run (a content-addressable cache skips work whose inputs haven't changed), and forkable (keep multiple candidate versions of any node side by side).

### What the narrative bundles produce

The shipped bundles walk a story end-to-end:

1. **Story essence** — extracts genre, throughline, tonal notes (an action thriller and an emotional drama produce structurally different scenes from the same pipeline).
2. **Scene extraction** — Stage A summaries → parallel Stage B beats. Hierarchical so long stories don't blow context.
3. **Screenplay** — duration-scaled. A 30-second video gets 2-3 characters and 2 scenes; a 3-minute video gets more.
4. **World style bible** — color palette, lighting, atmosphere — used as a reference dependency by every image prompt that follows. Supply your own art direction and it's used verbatim; leave it blank and it's generated from your story plus a style preset.
5. **Character & setting reference images** — generated against the style bible so a character looks the same in every shot.
6. **Per-shot prompts** — compact per-shot prompt JSON with character-state tracking across shots (no teleportation, no continuity errors).
7. **Keyframes** — first / first+last / first+mid+last frames, strategy chosen per shot.
8. **Shot videos** — image-to-video, text-to-video, FLFV, or FMLFV via the bundle's video runner.
9. **Final assembly** — FFmpeg concat with xfade transitions, resolution scaling, interleaved audio.
10. **Optional fidelity audit** — a VLM judge (calibrated to ≥80% per-question agreement with Claude) scores every keyframe against its prompt.

The exact DAG — which nodes run, in what order, with what prompts — is defined by the bundle, not hardcoded in the engine.

## Architecture

The **walker** (`src/dag/walker.ts`) walks a bundle's dependency graph. Each node is one LLM or media-generation call dispatched to a **runner**. The walker owns dependencies, retries (exponential backoff, 3-attempt cap), cascade invalidation, caching, and persistence; the model only generates content.

That inversion is the point — most agentic video tools ask the LLM to navigate its own state machine and break the moment it drifts. Here the code drives the graph and the model is just a content generator, so you get deterministic resumability, deterministic retries, and a clean contract any external agent can drive.

```
src/
├── dag/        Walker, bundle DAG schema, runners, event log, content-addressable cache,
│               cascade invalidation, versions / branches / fork
├── events/     In-process event emitter
├── core/       LLM router + provider config, content validation, context, timeline, fs
├── agent/pi/   In-process agent ("dhee"): tools, skill, session, headless drive harness
├── server/     Embed-host helpers (analytics, discovery, conversation, runner bridge)
└── services/   ComfyUI integration
```

## Bundles

A bundle is a self-contained directory under `src/dag/bundles/` (or a single `.json`). Its `bundle.json` declares an id, version, display metadata, the runners it needs (`dependencies.runners`, as semver ranges, validated before the walker starts), its user inputs, and its nodes (each with an `outputs.pattern` for where its artifact lands in the project). Prompts, schemas, and ComfyUI workflows live alongside it.

Bundles resolve from a search chain — `DHEE_USER_BUNDLES_DIR` → `DHEE_APP_BUNDLES_DIR` → `~/.kshana/bundles` → the repo's `src/dag/bundles` — first-seen-wins, so a user fork shadows a shipped default.

Two first-party bundles ship today:

- **Narrative Prompt Relay** — cinematic story → video via an LTX-2 director relay on a local ComfyUI endpoint. Best for slow-to-moderate paced, story-driven content; decomposes fast action into slower single-action beats.
- **Narrative Shot by Shot** — precise per-shot control. Best for dialogue and composed scenes.

(The repo also carries several experimental narrative bundles that aren't surfaced in the picker.)

## Runners

A runner is what actually executes a node. Each is a dot-namespaced tool registered with the `RunnerRegistry`:

| Tool | What it does |
|------|--------------|
| `llm.generate` | LLM text generation (story, scenes, prompts) |
| `comfy.image` | Image generation via ComfyUI (local or Cloud) |
| `comfy.qwen_edit_chain` | Iterative image editing (Qwen-Edit chain) |
| `comfy.ltx_director` | LTX-2 director-relay video synthesis |
| `ffmpeg.shot_clip` | Per-shot clip assembly |
| `ffmpeg.concat` | Final concat with xfade transitions |
| `vlm.judge` | VLM fidelity judge (keyframe-vs-prompt scoring) |

Built-in runners register at import time. Custom runners are discovered at startup from `~/.kshana/runners/` and ship a `runner.json` manifest (tool id, version, engine-compat range, required credentials). A bundle that depends on a runner whose credentials are unset fails validation *before* any work runs, naming the missing variable.

LLM and VLM runners select a provider independently: OpenRouter, Gemini, OpenAI, LM Studio, or any OpenAI-compatible endpoint.

## Requirements

- Node ≥ 20
- `ffmpeg` on `PATH`
- A ComfyUI endpoint (local `:8188` or `https://cloud.comfy.org`) for image/video generation
- An LLM provider (Gemini API key, OpenAI/OpenRouter key, or a local LM Studio)
- A VLM provider (e.g. OpenRouter) for the fidelity audit

## Install & build

```bash
git clone <repo>
cd dhee-core
pnpm install
cp .env.example .env   # then edit
pnpm build             # builds the React frontend + bundles the engine
```

`dhee-core` is a headless engine — there's no standalone server to start. You use it one of three ways:

- **Embedded** — `dhee-desktop` imports it in-process for the full local app.
- **As a library** — import the walker, runner registry, and agent bridge from the package.
- **Headless agent harness** — `pnpm drive` exercises the embedded "dhee" agent from the command line (`drive start`, `drive send <session> "<msg>"`, `drive list`).

## Environment

The full set lives in `.env.example`. Two common shapes:

**OpenAI-compatible LLM (OpenRouter) + Comfy Cloud:**
```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=...
OPENAI_MODEL=x-ai/grok-4.1-fast
COMFYUI_BASE_URL=https://cloud.comfy.org
COMFY_CLOUD_API_KEY=...
VLM_PROVIDER=openrouter
VLM_API_KEY=...
VLM_MODEL=anthropic/claude-haiku-4.5
```

**Fully local (ComfyUI + LM Studio):**
```bash
LLM_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_MODEL=qwen3
COMFYUI_BASE_URL=http://localhost:8188
```

When `COMFYUI_BASE_URL` is `https://cloud.comfy.org` the engine switches to Cloud API routes and requires `COMFY_CLOUD_API_KEY`; any other value stays on local/self-hosted behavior.

## Project format

A project is a directory on disk:

```
<project>/
├── project.json          Projected graph state (node statuses, content refs, bundleSource)
├── .dhee/
│   └── events.jsonl       Append-only event log — the source of truth
├── inputs/                Your inputs (story.md, …)
├── plans/                 Art direction / style bible (world_style.md, …)
├── images/                Character & setting refs, keyframes
└── videos/                Per-shot clips and the final cut
```

`project.json` and every other view are projections of `events.jsonl`; delete them and they rebuild from the log. Generated artifacts are also de-duplicated through a shared content-addressable cache at `~/.kshana/cache`, keyed on `(tool, version, inputs, config, seed)` — so re-running a node with unchanged inputs is instant.

## How the agent drives it

External agents (and the built-in one) drive the engine through a fixed set of tools, e.g.:

`dhee_list_bundles`, `dhee_present_bundle_choices`, `dhee_create_project`, `dhee_write_input`, `dhee_set_project_field`, `dhee_run_bundle` / `dhee_start_run` / `dhee_stop_run`, `dhee_get_status`, `dhee_show_node_output`, `dhee_regenerate_node`, `dhee_write_node_content`, `dhee_fork` / `dhee_list_versions` / `dhee_select_version`, `dhee_swap_runner`, `dhee_critique_node`.

This is the contract that keeps the engine agent-agnostic: the reference driver in `src/agent/pi/` is one consumer, but any agent that can call these tools can author a project.

## Testing & evals

```bash
pnpm test               # Vitest unit suite
pnpm test:e2e           # End-to-end
pnpm test:integration   # Integration
pnpm test:coverage      # Coverage report
pnpm lint               # tsc --noEmit && eslint
pnpm lint:fix
pnpm format             # prettier
```

The `vlm.judge` runner scores keyframes against their prompts (calibrated to ≥80% per-question agreement with Claude), so fidelity regressions are measurable rather than gut-feel.

## License

[GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0).

If you run a modified version of `dhee-core` as a network service, AGPL requires you to make the complete corresponding source available to users of that service. See `LICENSE` for the full terms.
