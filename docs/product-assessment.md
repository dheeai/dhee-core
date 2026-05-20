# dhee — Product Assessment

**Date:** 2026-05-02
**Scope:** `dhee-core` (the core engine) and `dhee-desktop` (the Electron shell that bundles it).
**Posture:** Objective. This is an internal critique, not marketing copy.

---

## 1. What dhee actually is

dhee is a two-layer product:

- **dhee-core** — a TypeScript "video generation OS." A single `ExecutorAgent` walks a dependency graph; each node makes its own LLM call through the router. There is no fleet of dispatched sub-agents — `GenericAgent` was deleted in the graph-as-source-of-truth refactor (see `src/core/index.ts:1`). Around the executor sit a manifest-driven workflow registry for ComfyUI / Google / xAI providers and an HTTP+WebSocket API. It can be run headless from the CLI, embedded in-process, or driven from outside via REST (the pi-agent integration). Note: `docs/agent-architecture.md`, the `taskTool`, and the `buildContentPrompt` / `buildImageGenerationPrompt` / `buildVideoGenerationPrompt` builders are stale — they describe the pre-refactor architecture and have no live callers.
- **dhee-desktop** — an Electron app (electron-react-boilerplate, React 19, SCSS modules) that embeds `dhee-core` as an in-process `ConversationManager` in local mode and connects to a release-configured backend in cloud mode. It adds Remotion-based compositing, a real timeline editor with audio, whisper-cpp captioning, CapCut export, and an auto-updater.

The split is real: the core can be used without the desktop (the test suite drives it that way), and the desktop can in principle point at a remote core. But the two ship together — the desktop's `package` script runs `verify:dhee-core`, packs `dhee-core` as a tarball, and bakes it into `release/app`.

---

## 2. Capability inventory (verified, not aspirational)

### 2.1 What dhee-core actually does

**Pipeline the engine can run end-to-end:**
1. Free-text story input
2. Story essence extraction (genre, throughline, tonal notes — persisted to `prompts/story_essence.json`)
3. Hierarchical scene extraction (Stage A summaries → parallel Stage B beats)
4. Screenplay generation, duration-scaled
5. World style bible (color palette, lighting, atmosphere)
6. Character + setting reference images, generated against the style bible
7. Per-scene prose → per-shot prompts (6-field JSON: description, cameraWork, audio, transition, duration, shotNumber)
8. First / first+last / first+mid+last keyframe images, strategy chosen per shot
9. Video clips per shot via image-to-video, text-to-video, FLFV, or FMLFV workflows
10. FFmpeg final assembly with xfade transitions
11. Optional fidelity audit: VLM judge scores every keyframe against its prompt

**Providers wired up:** ComfyUI (local + cloud), Google Imagen/Veo, xAI Grok, plus an OpenRouter-routed LLM tier with provider pinning for DeepSeek. Five visual style presets, five video templates (narrative, documentary, short, infomercial, graphic-novel).

**Operational features that distinguish it from a notebook script:**
- Code-driven dependency-graph executor; the agent generates content, the executor handles I/O, dependencies, and retries (exponential backoff, 3-attempt cap, self-repair tracking).
- Cascade invalidation: regenerate a node and everything downstream resets.
- Persistence: project state survives server restart and reconnects.
- Per-project execution lock prevents concurrent runs from multiple browser tabs.
- Manifest-driven workflow uploader: ComfyUI workflows in either LiteGraph or API format are auto-detected, inputs are introspected, LoRA trigger keywords are injected, and AnythingEverywhere implicit connections are resolved.
- Hand-curated VLM-judge calibration (`pnpm calibrate-vlm`) — the fidelity scoring is empirically tuned to >=80% per-question agreement with Claude on a calibration set.
- Server discovery file (`~/.dhee/server.json`, mode 0600) so external agents can find a desktop-launched core without knowing the random port.
- 87+ test suite plus eval harness, including TDD discipline visible in the file layout (every service has a `*.test.ts` next to it).

### 2.2 What dhee-desktop adds on top

- Electron shell with native menu, auto-updater (electron-updater), GitHub Releases publishing, signed Mac (arm64 + x64) and Windows NSIS installers.
- Two-mode connection: Local (embedded core in the main process) and Cloud (release backend with desktop auth token + account/balance manager).
- File explorer with tree, context menu, inline rename, and active-context tracking.
- A real timeline editor (`TimelinePanel`) with audio import, waveform display, drag-resize, scene action popover, per-shot regenerate modal, image positioning, and version selector. (Note: a separate `TimelineView` component is a "Timeline coming soon" placeholder — not the timeline you actually use.)
- Storyboard view, Video Library view, Plans (markdown) view, Asset cards with media preview, CodeMirror-based JSON/YAML/Markdown editor.
- Remotion 4.0.409 bundler + renderer, bundled browser executable, with infographic placement, prompt-overlay ASS subtitles, three.js / mapbox-gl / turf for geo overlays.
- Whisper-cpp for word-level caption generation on existing audio tracks.
- CapCut project export, prompt-overlay ASS export, chat JSON export.
- ProjectFileOpGuard — defensive containment checks before main-process FS operations.
- E2E coverage with Playwright; unit coverage with Jest + React Testing Library.

---

## 3. Objective strengths

**3a. Architectural separation is real.** The desktop / core split is not a fiction — `verify:dhee-core` packs the core as an npm tarball, and the desktop loads it through a webpack-ignored ESM dynamic import. That makes the engine swappable, testable in isolation, and remotely drivable. Most "AI desktop apps" hard-couple the UI to the pipeline; this one doesn't.

**3b. The graph executor is the right abstraction.** Code drives the pipeline; the LLM is just a content generator called per node. This is the inversion most agentic video tools fail to make — and dhee made it deliberately, deleting the previous `GenericAgent` / sub-agent dispatch layer in favour of a single `ExecutorAgent` that walks the graph. It buys deterministic resumability, deterministic retries, deterministic cascade invalidation, and a clear contract for external drivers (pi-agent). Compare against any tool that asks an LLM to navigate its own state machine — those break the moment the LLM drifts.

**3c. Provider neutrality.** ComfyUI (local + cloud), Google, xAI, OpenRouter — all plumbed through a `ProviderRegistry` with per-capability selection. Workflows are user-uploadable. LoRA keyword injection is configured per-manifest. This is a category most "generate a video" SaaS products don't even try to compete in: bring-your-own-workflow with real ComfyUI compatibility (LiteGraph + API formats, AnythingEverywhere resolution).

**3d. Editorial intent is modeled, not stapled on.** `story_essence` is extracted before scene breakdown and threaded through Stage A and Stage B prompts. An emotional drama and an action thriller produce structurally different scenes from the same pipeline. Most competitors apply tone via a global style prompt; this conditions the structural decomposition itself.

**3e. Fidelity has measurement.** A calibrated VLM judge with audited per-question agreement is rare. `pnpm audit-fidelity <project>` produces a per-shot, per-scene, bottom-quartile report. Without that, "did the AI make the right thing?" is gut feel. With it, regressions are visible.

**3f. The desktop's timeline is more than a viewer.** Shot regenerate modal, audio import + waveform, version selector, scene action popover, drag resize with snap, image positioning overrides — this is a genuine NLE-lite, not a progress bar. Combined with CapCut export and ASS subtitle export, the user has a real off-ramp to professional editors when they outgrow the in-app timeline.

**3g. Pi-agent / external-driver story.** The REST endpoints (`/run-to`, `/stop`, `/status`, `/nodes/:alias`, `/regen`, `/override`) plus the `~/.dhee/server.json` discovery file make the core programmable from outside. This is unusual for a desktop app. It opens batch generation, headless cloud rendering, and CI use cases without re-implementing the engine.

**3h. Test discipline is visible.** `*.test.ts` next to every service in both repos, eval harnesses, calibration scripts, Playwright E2E in the desktop. The CLAUDE.md rules ("no grep-the-source tests, exercise actual behavior") are enforced in practice.

---

## 4. Where it falls short

**4a. No generated audio.** This is the largest gap and `future-features.md` admits it. Whisper captions assume audio already exists. There is no TTS / narration / dialogue / music / SFX pipeline. The `MultiShotMotionPrompt` schema has `dialogue` fields the engine does not use. Most consumer-facing video tools (Runway, Pika, ElevenLabs Studio, descript) ship audio. A silent video is a prototype, not a product.

**4b. No reviewed approval flow at all.** `future-features.md` claims 50+ approval gates per video — that is a stale doc. The graph executor does not gate per-item approvals; the old GenericAgent / Task-dispatch flow that did has been deleted, and its leftover types (`ItemApprovalStatus`, `ItemApprovalEntry`, `*ApprovalStatus` fields, `ExecutorCallbacks.onApprovalNeeded`) are dead code marked for deletion in `todos/cleanup-deprecated-agent-architecture.md`. The opposite problem now applies: **there is no human-in-the-loop review path between "I asked for a video" and "the executor handed me one."** A user who wants to approve the screenplay before shots get generated, or veto a character image before the pipeline burns 10 shots' worth of GPU on it, has no built-in seam for that — they have to `pnpm run-to <stage>`, inspect, then `regen` / `override`. The new structured-review feature in `todos/approval-gates.md` is unbuilt. So the gap is not "too many gates," it's "no gates with criteria attached."

**4c. ComfyUI dependency is heavy and unstable.** The "ComfyUI Cloud cache leak" memory documents that cloud.comfy.org returns cached outputs from other users when workflow hashes collide — a correctness bug we worked around by checking `prompt_id` in the WS handler, not a property of the platform. Local ComfyUI requires GPU, port forwarding (zrok), and ~$50-100/month per `PROJECT_STATUS.md`. For a desktop-app target audience this is a non-starter; for a power-user audience it works but the ramp is steep.

**4d. Bundle size and packaging fragility.** The `asarUnpack` block in `dhee-desktop/package.json` is enormous — Remotion + bundler + webpack + `@react-three/fiber` + mapbox + better-sqlite3 + sharp + the entire dhee-core bundle. Every native module needs `electron-rebuild`. The `prepare:app-deps` step packs the core as a tarball and reinstalls into `release/app`. Each release moves a lot of bytes and has a lot of surfaces to fail on.

**4e. The `TimelineView` placeholder ships in the binary.** It is wired into the build but renders "Timeline coming soon." Users who navigate to the wrong tab see a disabled feature. The real timeline is `TimelinePanel`. This is exactly the kind of cruft that erodes trust on first run.

**4f. Phase prompt files are dead.** Per the project memory (`MEMORY.md`), `prompts/templates/*/phases/*.md` are validated for presence but never loaded at runtime. They invite editing-without-effect. The `promptFile` field is schema-only. New contributors will burn hours editing prompts that have no behavioral consequence.

**4g. Cloud mode is half-built.** "Cloud connects to a release-configured remote backend" — the desktop has the auth-token plumbing, the account/balance UI, and a CapCut export, but the cloud backend itself is not in the repo. The cloud story is currently: trust the release config, hope the GPU is up. There is no documented multi-user, no team workspace, no shareable project URL.

**4h. Single-user, no collaboration.** No project sharing. No comment / review. No multi-seat license. The project format (`<name>.dhee/` directory of JSON + media) is portable in principle but there is no diff, no merge, no upload-and-collaborate path. For a video tool in 2026 this is a meaningful gap — Frame.io, Canva, and Descript all assume collaborative review.

**4i. The development repo is an asset graveyard.** 60+ `*.dhee` folders sit in the repo root. They are useful for hands-on debugging and probably explain a lot of the "calibration set" memories, but they are not tracked, not pruned, and confuse new contributors about what is sample data vs. project state. The desktop installs `~/dhee` separately, which is the right call — but the repo doesn't model that separation cleanly.

**4j. Reliability of long story extraction.** The hierarchical scene extractor was added because the single-call version "hung silently on long stories." It has a 90s timeout and one retry per Stage B call. This is a band-aid, not a fix; for very long inputs (novels, transcripts), the right answer is streaming, not chunked synchronous calls.

**4k. Cost transparency is absent at the desktop layer.** The core has `LLMLogger` token/cost tracking. The desktop's account tab shows balance — but per-project / per-shot cost is not surfaced in the timeline or shot card. Users do not know what a "regenerate this shot" button click costs them until they hit the balance.

**4l. Onboarding requires too much.** README expects: Node 20+, sibling `dhee-core` repo, ComfyUI, LM Studio / Gemini / OpenAI credentials. The desktop's local mode reduces this somewhat, but if a user opens the app and hasn't run a ComfyUI tunnel, the failure mode is a stalled job, not a clear "you need to configure this provider first" splash.

---

## 5. What would make it marketable

These are the features that already exist and are differentiators:

- **Bring-your-own ComfyUI workflow with real format compatibility.** This is a small, technically demanding audience but they pay. Pitched to ComfyUI power users, "drop your workflow in, get a 2-minute video" is unique.
- **Calibrated fidelity audit.** "Score every shot against its prompt with a tuned VLM judge" is a feature no consumer tool has. Sold as a QA layer for video agencies, this is real.
- **External agent control.** REST + discovery file + pi-agent integration means dhee can be a backend for someone else's UI, including a coding agent. This is a B2B integration story.
- **Editorial-intent-aware decomposition (story essence).** "We don't just write the screenplay, we read the genre first" is a credible quality differentiator vs. competitors that apply tone as a global prompt.
- **Multi-strategy video generation per shot (T2V / I2V / FLFV / FMLFV).** Most tools pick one. Auto-routing per-shot to the right keyframe strategy is a meaningful quality lever.
- **Transparent execution.** Every tool call is visible in the chat with arguments and results; the SQLite session DB stores the full history. This is rare and is the thing developers and power users want — they don't want a black box.
- **CapCut export + ASS subtitle export.** The "off-ramp to a real editor" is a feature, not a defeat. It says "we are not trying to be your final timeline; we are trying to be your draft generator."
- **Local-first.** No mandatory cloud, no mandatory subscription, no per-image API cost. For a meaningful slice of buyers (privacy-sensitive, narrative writers, indie game devs, ML hobbyists), this is the buying reason.

---

## 6. What makes it a hard sell as-is

These are the features that a paying customer notices on day one:

- **No audio.** Demo videos are silent. Every competitor has voice. This is the single largest perceived-quality gap.
- **No reviewed-approval seam.** The executor runs end-to-end (good for the demo loop) but there is no built-in path to pause, review against criteria, and resume. Power users want gates with structure; consumers want one-click. dhee currently offers neither.
- **ComfyUI requirement for local.** The product can't be evaluated in 5 minutes without external setup. Cloud mode shifts this to "trust our backend," which is opaque.
- **No collaboration.** The 2026 default for any creative tool is "share a link." dhee cannot.
- **Bugs visible on first run.** "Timeline coming soon" placeholder; phase prompt files that do nothing; very long stories that need a chunked extractor with retries. These are tells of a tool still in alpha.
- **Cost opacity.** A user who regenerates 10 shots without knowing the cost will not regenerate the 11th, regardless of what the result looks like.
- **Bundle weight.** Mac DMG with Remotion + ComfyUI client + better-sqlite3 + sharp + maps + three.js is a heavy first download. First-launch native rebuild can fail in ways the user can't diagnose.

---

## 7. Honest summary

dhee is a **strong engine in a half-finished product wrapper**. The core is more architecturally serious than most video-AI tools — graph executor, calibrated fidelity scoring, real provider neutrality, external programmability. The desktop adds genuine timeline editing and Remotion compositing, both of which are non-trivial. The TDD discipline and test density argue that this team can ship.

What is missing is not engineering capacity. It is **completing the product loop**: audio so the output isn't silent, a reviewed-approval seam so power users can intervene with criteria (the structured-review feature in `todos/approval-gates.md`), a hosted cloud mode so evaluation doesn't require GPU setup, collaboration so the output can be shared, and cost surfacing so users can budget their regeneration habits. Until those land, dhee is best positioned as **a power-user / agency / B2B engine** rather than a consumer creator tool — and the marketing should match. Selling it as a Pika/Runway competitor will disappoint. Selling it as "ComfyUI orchestration for narrative video, with a real timeline and a real engine" will not.

The two single highest-leverage things to ship next, in order:

1. **An audio pipeline** (TTS narration + per-character dialogue, even with a single provider). Without this, no demo lands.
2. **The structured-review approval flow** from `todos/approval-gates.md` — criteria-tagged review with optional LLM self-review and auto-regenerate. Built on top of the existing fidelity audit, this gives power users the intervention seam they want without re-introducing the deleted approval-fatigue gates.

Everything else — collaboration, cloud onboarding, cost UI, deleting the deprecated agent-architecture surface tracked in `todos/cleanup-deprecated-agent-architecture.md`, replacing the `TimelineView` placeholder with a redirect to `TimelinePanel` — is bookkeeping that becomes urgent only after those two land.
