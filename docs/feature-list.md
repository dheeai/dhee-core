# dhee-Core Feature List

## Smart Video Creation Engine

- **Automatic Step-by-Step Execution** — dhee figures out all the steps needed to make your video and runs them in the right order automatically. _Uses a dependency graph executor that processes tasks by dependency order._
- **Intelligent Planning** — Just describe what you want, and the system works backward from the final video to determine every piece of content it needs to create. _Backward planner resolves all required dependencies from target artifacts._
- **Automatic Content Splitting** — When a story has 5 characters, the system automatically creates separate tasks for each one — no manual setup needed. _Collection expansion splits type-level nodes into per-item nodes based on extracted content._
- **Choose Your Speed** — Run in serial mode (finish all writing before generating images) or parallel mode (start generating images while still writing) depending on your preference. _Serial mode completes LLM content before media generation; parallel mode runs both concurrently._
- **Auto-Recovery from Errors** — If something fails (API timeout, service hiccup), the system automatically retries up to 3 times before giving up. _Exponential backoff retry with self-repair tracking._
- **Pick Up Where You Left Off** — Close the browser, restart the server — your project remembers exactly where it stopped and continues from there. _Executor state persists to project.json and restores on reconnect._
- **Redo Any Step** — Don't like how a character image turned out? Hit the redo button and it regenerates that step plus everything that depends on it. _Cascade invalidation resets the node and all downstream dependents._
- **One Project at a Time** — Prevents accidental double-runs on the same project, even across multiple browser tabs. _In-memory + file-based lock prevents concurrent execution._

## AI-Powered Storytelling

- **Screenplay Writing** — The AI writes a proper screenplay with dialogue and stage directions, not just a story paragraph — this keeps characters and scenes focused for the video length. _LLM generates duration-constrained screenplay format to control entity counts._
- **Smart Scaling** — A 30-second video gets 2-3 characters and 2 scenes. A 3-minute video gets more. The AI automatically adjusts scope to fit your chosen duration. _Character, setting, and scene counts scale with video duration._
- **Visual Style Guide** — Before generating any images, the AI creates a unified "look and feel" document covering color palette, lighting, atmosphere, and textures — so every image in your video looks like it belongs together. _World style bible used as dependency by all image generation prompts._
- **Consistent Characters & Settings** — Character and setting reference images are generated using the style guide and each other as references, so your hero looks the same in every shot. _Reference image injection with world style context for visual consistency._
- **Cinematic Shot Descriptions** — Each shot gets a detailed 100-200 word description written like a cinematographer's notes — describing camera movement, character actions, lighting shifts, and atmosphere. _LTX-optimized motion directives with character anchoring and sound-to-visual translation._
- **Scene Breakdown** — Each scene is broken into individual shots with camera directions, transitions, and audio — like a real storyboard. _Slim 6-field JSON per shot (description, cameraWork, audio, transition, duration, shotNumber) with autoresearch-optimized guide._
- **Scene State Tracking** — The system tracks where every character is positioned, what they're doing, and what they're holding — across shots. No teleportation or continuity errors. _Per-character state (position, pose, expression, hands, legs, facing) extracted by LLM after each shot, injected before the next._
- **Graph-Based Reference Resolution** — All completed character, setting, and object images are automatically gathered from the execution graph and presented to the shot composition LLM — no manual reference mapping needed. _buildAvailableReferences scans executor graph for completed ref nodes._
- **Self-Improving Prompts** — The prompt templates that guide the AI were optimized using an automated evaluate-and-improve loop, reaching 94-97% quality scores. _Autoresearch optimization loop with binary rubric evaluation._
- **Hierarchical Scene Extraction** — Long stories are broken down using a Stage A summary call (scene boundaries + 80-150 word summaries, no beats) followed by N parallel Stage B calls (each gets the full story plus one scene's summary, returns just that scene's beats). Each call has a 90s timeout and one retry. Replaces the single giant cluster call that hung silently on long stories. Falls back to the legacy single-call flow if the hierarchical path throws. _hierarchicalSceneExtractor.ts; chunked output, full-story input — no context loss._
- **Story Essence (Editorial Intent)** — Before scene breakdown, the system runs a focused `story_essence` LLM call that extracts genre, throughline, tonal notes, and dramatic emphasis. This editorial intent is persisted to `prompts/story_essence.json` and threaded into the scene extractor and per-scene prose generation, so an emotional drama gets quiet, lingering scenes while an action thriller gets punchy, kinetic ones — same pipeline, completely different feel. Stop at the stage to inspect/edit before scene generation: `pnpm run-to <project> story_essence`. _storyEssenceExtractor.ts + storyEssenceContextBlock.ts; per-scene Stage A and Stage B include editorial license to invent atmosphere/reaction beats the source under-serves if doing so strengthens the throughline._

## Video Generation

- **Multiple AI Providers** — Generate images and videos using your local ComfyUI setup, Google's cloud APIs, or xAI's Grok — choose per task type. _Supports ComfyUI, Google Imagen/Veo, and xAI API with per-capability provider selection._
- **Strategy-Aware Workflow Routing** — The AI picks the best video generation approach per shot (image-to-video, text-to-video, first+last frame, first+mid+last frame), and the system routes to the right workflow — preferring your uploaded workflow if it supports that strategy. _getWorkflowForStrategy() maps semantic strategies to workflows with user override priority._
- **First + Last Frame Video (FLFV)** — Upload a workflow that takes both a first and last frame image, and the system automatically generates both frames and wires them through. The AI decides per shot whether FLFV is needed based on whether the shot has a clear visual start and end state. _Multi-frame generation from inputRequirements, uploaded and parameterized via manifest mappings._
- **First + Mid + Last Frame Video (FMLFV)** — For maximum control, upload a workflow that uses three keyframe images. The AI generates first, middle, and last frame images for shots with specific visual beats. _Extends FLFV with mid_frame support._
- **Stop Button** — Stop the AI mid-execution from the header. It finishes the current step and pauses — select the project again to resume from where it left off. _Sends cancel WebSocket message, executor breaks at next node boundary._
- **Progress Bars in Tool Cards** — Video generation progress shows as a visual bar instead of raw text, with step counts and percentages. _Parses "Step 2/3 (67%)" from streaming text into visual progress bar._
- **Workflow Name in Tool Cards** — See which workflow is being used for each shot directly in the chat — shown as a cyan badge above the prompt. _Workflow name injected into tool_call arguments and result metadata._
- **Automatic Final Assembly** — All your shot videos are stitched together into one final video with proper sequencing, audio handling, and resolution matching. _FFmpeg concat filter with interleaved video+audio pairs and resolution scaling._
- **Cinematic Transitions** — Shots blend together with professional transitions — crossfades, dips to black, flash cuts, wipes, and more — chosen by the AI to match the mood. _FFmpeg xfade chain with LLM-selected transition types per shot._

## Timeline

- **Visual Timeline** — See your entire video as a timeline of segments, each showing its status (empty, planned, or filled with generated content). _Timeline.json with segments mapped to shot nodes._
- **Live Progress Tracking** — Watch the timeline fill up in real-time as each shot is generated — you can see exactly how far along your video is. _WebSocket pushes timeline state on every shot_video completion._
- **Timeline-Driven Assembly** — The final video is assembled from the timeline, ensuring the correct order, durations, and transitions are preserved. _resolveSegmentFilePaths from timeline with 3-tier fallback._
- **Transition Preservation** — Transitions you see in the scene breakdown carry all the way through to the final assembled video. _Transitions propagate from scene_video_prompt through timeline segments to FFmpeg._
- **Completeness Checking** — Before assembling the final video, the system verifies every segment has content and warns about any gaps. _Timeline validation tracks filled duration, gaps, and warnings._
- **Regeneration History** — Every time you redo a shot, the previous version is saved — nothing is lost. _Segment layers auto-snapshot on regeneration with version tracking._

## Custom Workflows

- **Workflow Library** — Browse and manage all available generation workflows — see which ones are active for image generation, video generation, and image editing. _Manifest-driven workflow registry with pipeline type grouping._
- **Upload Your Own Workflows** — Bring your own ComfyUI workflows — the system auto-detects inputs, uses AI to understand what the workflow does, and helps you configure it. _Upload wizard with input node detection and LLM-powered analysis._
- **Test Before You Use** — Try out any workflow with test inputs before using it in a real project — see the results instantly. _Standalone test panel with dynamic input fields and ComfyUI execution._
- **LoRA Keyword Injection** — If your workflow uses LoRA models that need trigger words (like "GHIBSKY style"), configure them once and they're automatically added to every prompt. _promptKeywords field on manifest with prepend/append injection._
- **Broad ComfyUI Compatibility** — Works with workflows that use "Anything Everywhere" nodes and other popular extensions — the system resolves implicit connections automatically. _AnythingEverywhere resolution wires implicit connections for API compatibility._
- **Any Workflow Format** — Upload workflows exported from the ComfyUI node editor or the API — both formats are supported and auto-detected. _LiteGraph and API format detection with automatic conversion._
- **Defaults You Can Override** — Built-in workflows are always available, but you can upload your own and set them as the active workflow for any pipeline. _Built-in workflows are immutable; user workflows can override per pipeline._

## User Interface

- **Live Chat View** — Watch the AI think in real-time as it writes your story, generates prompts, and creates images — everything streams into a chat-like interface. _Interleaved messages and tool calls with streaming indicators._
- **Timeline View** — Switch to a visual timeline showing all segments as proportional blocks with color-coded status, duration labels, and transition indicators. _Horizontal segment visualization with fill status and progress bar._
- **Two-Tab Layout** — Easily switch between the Chat view (see what the AI is doing) and the Timeline view (see your video taking shape). _Tab switching with fill progress counter badge._
- **Progress Sidebar** — The sidebar shows your current phase, a task checklist with live status updates, and a grid of all generated images. _Phase display, todo list with status icons, and asset thumbnails._
- **One-Click Redo** — Hover over any completed task in the sidebar and click the redo button to regenerate it. _Hover-reveal redo icon on completed/failed todos._
- **Easy Project Creation** — Create a new project right in the chat: pick a template, choose a visual style, set the duration, then describe your video idea. _Inline wizard with template cards, style grid, and duration buttons._
- **Slash Commands** — Type `/` to see available commands — `/new` for a new project, `/workflows` to manage workflows, `/providers` to change AI providers, and more. _Command routing with autocomplete popup on keystroke._
- **Smart Autocomplete** — Start typing `/` and a popup shows matching commands — navigate with arrow keys and press Tab to select. _Command autocomplete with keyboard navigation._
- **Workflow Manager** — A full-screen modal for browsing, uploading, testing, and activating workflows — organized by what they do. _List/wizard/test views with pipeline grouping._
- **Provider Settings** — Choose which AI service handles image generation, image editing, and video generation from simple dropdown menus. _Modal with per-capability provider selection._
- **Polished Dark Theme** — A carefully designed dark interface with cyan and green accents, frosted glass panels, and subtle animated backgrounds. _Glassmorphic design system with aurora glow and grid overlay._

## Real-Time Updates

- **Live AI Output** — See the AI's writing appear word by word as it generates your screenplay, prompts, and descriptions. _Real-time LLM streaming with tool-scoped content._
- **Transparent AI Actions** — Every action the AI takes (generating an image, writing a prompt, assembling video) is shown with its inputs and outputs — nothing is hidden. _Tool call cards with arguments, streaming content, and results._
- **Live Task Tracking** — Your task list updates in real-time as steps move from pending to in-progress to completed. _WebSocket-driven todo updates as nodes progress._
- **Live Timeline Updates** — The timeline view updates instantly as each shot video is generated — watch your video come together segment by segment. _Full timeline state pushed on every segment fill._
- **Status Notifications** — Get notified when phases change, when errors occur and are retried, and when major milestones are reached. _Phase transition, error/retry, and completion notifications._
- **AI Usage Stats** — See how much of the AI's context window has been used, displayed in the header. _Token usage and compression status display._

## Video Templates

- **Narrative Video** — The full cinematic experience: from a story idea to a complete video with characters, settings, scenes, shot-by-shot images, and assembled video with transitions.
- **Documentary** — Start with a thesis, build an outline with sources, generate segment visuals, and assemble into a documentary-style video.
- **YouTube Shorts** — Hook-first format: write a punchy script, generate key visuals, and assemble into a vertical short-form video.
- **Infomercial** — Product-focused: define your value proposition, script the demo, generate product visuals, and assemble into a promotional video.
- **Graphic Novel** — Panel-based storytelling: write the story, design characters and settings, and generate illustrated panels for a graphic novel layout.

## Visual Styles

- **Cinematic Realism** — Photorealistic visuals with dramatic lighting and cinematic composition.
- **Anime** — Vibrant colors with clean lines in classic anime style.
- **Stylized 3D** — Pixar/Disney-inspired characters and environments with rich detail.
- **Watercolor** — Soft, flowing artistic look with painterly textures.
- **Custom** — Define your own visual style with specific instructions for the AI.

## Developer / Infrastructure

- **Full Type Safety** — The entire codebase uses TypeScript with strict mode for reliability. _Strict TypeScript across backend and frontend._
- **Automated Test Suite** — 87+ tests covering backend logic and frontend components to catch regressions. _Vitest with backend integration and React component tests._
- **Detailed Logging** — Every AI call, every tool execution, and every decision is logged for debugging. _Per-phase logs, executor logs, and LLM token/cost logs in logs/ folder._
- **Full History Database** — Every action taken during a session is recorded in a searchable database. _Session SQLite DB with complete tool call history._
- **Project Reset** — Reset any project back to a specific stage to re-run from that point forward. _`pnpm reset <project> <stage>` script._
- **Fidelity Audit** — Score every rendered shot's first/last keyframe against its prompt using a calibrated VLM judge; produces a markdown report with per-shot, per-scene, and bottom-quartile callouts. _`pnpm audit-fidelity <project>`._
- **VLM Judge Calibration** — Tune the VLM judge prompt by diffing per-question verdicts against Claude on a hand-curated set; passes at >=80% agreement. _`pnpm calibrate-vlm` with cached Claude verdicts._

## API

- **Health Check** — Verify the server is running and responsive. _`GET /api/v1/health`_
- **Session Management** — List, inspect, and delete active sessions. _REST endpoints for session CRUD._
- **Provider Configuration** — Read and update which AI provider handles each capability. _`GET/POST /api/v1/providers`_
- **Workflow Management** — List, upload, test, activate, and delete workflows via API. _REST endpoints for workflow CRUD._
- **Asset Serving** — Access any generated image or video by project and path. _`GET /api/v1/assets/:project/:path`_
- **Real-Time Communication** — Full bidirectional streaming between the UI and the server. _WebSocket at `/api/v1/ws/chat`._
- **Agent-Control Endpoints** — External agents (pi-agent, openclaw, anything that can hit HTTP) can drive a project end-to-end without spawning child processes or having Node installed. _`POST /api/v1/projects/:name/run-to`, `POST .../stop`, `GET .../status`, `GET .../nodes/:alias`, `POST .../regen`, `POST .../override`._
- **Server Discovery File** — Server writes `~/.dhee/server.json` (mode 0600) with its URL, port, and pid on launch so external agents can find it without knowing the random port the desktop allocated. Removed on graceful shutdown; clients verify pid is alive to detect stale files. _`dhee_DISCOVERY_FILE` env var to override path._
- **OpenRouter Provider Pinning for DeepSeek** — DeepSeek models on OpenRouter pin upstream providers (DeepSeek → SiliconFlow → NovitaAI by default) instead of the lottery default pool. Eliminates empty-0-char responses and 2-5x latency variance from slow upstreams. Other model families unaffected. _`OPENROUTER_DEEPSEEK_PROVIDERS` env to override the order._
