# Contributing to Dhee Core

Thank you for helping improve `dhee-core`. This project is the headless AI video generation engine behind Dhee: it turns a story idea into screenplay, references, keyframes, shot videos, and final assembly through a resumable TypeScript pipeline.

The codebase is moving quickly. Keep contributions small, measurable, and easy to review.

## Contribution Priorities

We value contributions in this order:

1. **Correctness and data safety** - deterministic graph execution, resumability, cascade invalidation, project state migration, and prevention of generated asset loss.
2. **Reliability** - retries, cancellation, process cleanup, WebSocket progress, provider fallbacks, and useful error messages.
3. **Test coverage** - behavior tests for pipeline logic, provider routing, server APIs, frontend flows, and regression cases.
4. **Prompt and workflow quality** - measurable improvements to screenplay, image prompt, motion prompt, reference consistency, and final-video fidelity.
5. **Provider and workflow integration** - ComfyUI, Comfy Cloud, LLM, VLM, image, edit, and video providers wired through existing registries.
6. **User-facing clarity** - CLI/server/frontend behavior, docs, examples, and diagnostics.
7. **Refactors** - welcome when they reduce real complexity and come with tests that prove behavior did not drift.

Avoid large PRs that mix refactors, prompt changes, workflow changes, and UI changes. Split them unless one cannot work without the other.

## Development Setup

### Prerequisites

| Requirement      | Notes                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| Node.js          | Version 20 or newer.                                                         |
| pnpm             | This repo declares `pnpm@10.24.0` in `package.json`.                         |
| ffmpeg / ffprobe | Required for video assembly and some tests.                                  |
| LLM provider     | Gemini, OpenAI/OpenRouter, LM Studio, or another OpenAI-compatible endpoint. |
| ComfyUI provider | Local ComfyUI or Comfy Cloud for image/video generation.                     |

### Install

```bash
git clone https://github.com/dheeai/dhee-core.git
cd dhee-core
pnpm install
cp .env.example .env
```

Edit `.env` for your local provider setup. Common options:

```bash
# Local LM Studio + local ComfyUI
LLM_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_MODEL=qwen3
COMFYUI_BASE_URL=http://localhost:8188

# OpenRouter/OpenAI-compatible LLM + Comfy Cloud
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=...
OPENAI_MODEL=...
COMFYUI_BASE_URL=https://cloud.comfy.org
COMFY_CLOUD_API_KEY=...
```

Do not commit `.env`, `.llm-routing.json`, generated project folders, logs, or provider secrets.

### Run Locally

```bash
pnpm start
```

`pnpm start` builds the frontend and starts the HTTP/WebSocket server. By default, the UI is served from `http://127.0.0.1:3000`.

For development with server watch mode:

```bash
pnpm dev
```

Useful project commands:

```bash
pnpm new <name>                 # Create a new .dhee project
pnpm run-to <project> <stage>   # Run the pipeline to a stage
pnpm status <project>           # Show project status
pnpm inspect <project>          # Inspect graph state and content
pnpm nodes <project>            # List graph nodes
pnpm regen <project> <node>     # Regenerate a node and downstream nodes
pnpm reset <project> <stage>    # Reset a project back to a stage
pnpm stop                       # Stop the running executor
```

## Project Structure

```text
dhee-core/
|-- src/
|   |-- core/                  # Executor, graph, prompts, providers, project state
|   |-- agent/pi/              # Headless adapter for external agents
|   |-- server/                # HTTP/WebSocket API and conversation manager
|   |-- services/              # ComfyUI, providers, asset/workflow services
|   |-- tasks/                 # Video task pipelines
|   |-- templates/             # Pipeline templates
|   `-- testing/               # Test/eval helpers
|-- frontend/                  # Vite React frontend
|-- prompts/                   # System, tool, workflow, skill, and reference prompts
|-- workflows/                 # Built-in, cloud, local, and user workflow definitions
|-- scripts/                   # Local maintenance, probes, evals, and project tools
|-- tests/                     # Unit, integration, e2e, eval, server, and fixture tests
|-- docs/                      # Architecture and feature docs
`-- deploy/                    # Deployment assets
```

The core architecture is deliberate: code drives the dependency graph and persistence; LLMs and media providers generate content for specific nodes. Keep that separation intact.

## Command Reference

Run these before opening a PR:

```bash
pnpm lint              # TypeScript check + ESLint
pnpm test              # Fast unit suite: tests/unit/
pnpm build             # Frontend build + package build
```

Run broader checks when the change touches shared behavior:

```bash
pnpm exec vitest run       # Full suite, same intent as CI
pnpm test:integration      # Integration tests
pnpm test:e2e              # Core e2e tests
pnpm test:coverage         # Coverage report
pnpm test:frontend         # Frontend Vitest suite
pnpm -C frontend test:e2e  # Frontend Playwright suite
```

Prompt and media-quality checks:

```bash
pnpm eval:mock                 # Mocked prompt evals
pnpm eval                      # Live evals; use only when provider keys are configured
pnpm audit-fidelity <project>  # VLM keyframe fidelity report
pnpm lint:prompts             # Prompt token/syntax guardrails
```

CI installs ffmpeg, runs `pnpm install --frozen-lockfile`, and executes `pnpm exec vitest run` on Node 20.

## Coding Standards

- Use TypeScript and the existing module boundaries. Prefer changes in the owning subsystem over broad cross-cutting edits.
- Keep prompt text in files under `prompts/` or an appropriate prompt module, then import/load it. Do not bury large prompts inside unrelated implementation files.
- Never truncate user-visible CLI text. If output is long, make the UI scrollable or paginated instead.
- When debugging, check `logs/` and relevant per-project logs before guessing.
- Catch specific errors where possible and include actionable context. Avoid swallowing provider failures without surfacing what failed.
- Preserve resumability. Any node-generation change must respect persisted `project.json`, prompt files, manifests, assets, and downstream invalidation.
- Do not hardcode provider credentials, local absolute paths, model names, ports, or ComfyUI workflow assumptions unless the existing config layer explicitly owns them.
- Generated outputs belong in ignored project/output directories, not in source control.
- Keep formatting consistent with Prettier: semicolons, single quotes, two spaces, trailing commas where valid, and 100-column print width.

ESLint enforces typed linting, unused-variable rules, and type-only import consistency. Prefer fixing lint issues directly instead of disabling rules.

## Testing Standards

Tests should exercise behavior, not implementation text.

- Do not write tests that grep or search source files for strings. Call functions, render components, hit APIs, or inspect produced outputs.
- Use unit tests for pure graph logic, routing, validation, state migration, prompt builders, and provider adapters.
- Use integration tests when executor state, persistence, invalidation, or multiple modules interact.
- Use e2e tests when server endpoints, WebSocket behavior, or full pipeline orchestration matters.
- Mock LLM/media providers in automated tests. Live provider calls belong in eval scripts, probes, or clearly manual workflows.
- Add fixtures under `tests/fixtures/` when a regression depends on real project state or media metadata.
- If a change touches ffmpeg behavior, make sure it passes in an environment where `ffmpeg` and `ffprobe` are on `PATH`.

When adding a regression test, name the behavior it protects. A future contributor should be able to understand why the test exists without reading the original bug report.

## Frontend Contributions

The frontend lives in `frontend/` and is a Vite React app.

```bash
pnpm -C frontend build
pnpm -C frontend test
pnpm -C frontend lint
pnpm -C frontend test:e2e
```

Frontend changes should keep the local engine workflow first: project selection, provider settings, chat/task execution, storyboard/timeline state, workflow management, and streamed progress. Prefer existing components and state helpers before introducing a new pattern.

## Providers and Workflows

Provider support should go through the existing registry/config paths. A contribution should make clear:

- Which capability it affects: LLM, VLM, image generation, image editing, video generation, or final assembly.
- Which provider mode it supports: local, cloud, OpenAI-compatible, ComfyUI API, or Comfy Cloud.
- Which env vars or config fields are required.
- How it behaves when credentials, models, workflows, or remote services are missing.
- Which tests prove routing and failure behavior.

Workflow JSON and manifests should be committed only when they are meant to be shared by the project. Personal workflow files belong under ignored paths such as `workflows/user/`.

## Prompt Contributions

Prompt changes can create large behavioral shifts. Keep them reviewable:

- State the failure mode or quality target in the PR.
- Keep prompt edits scoped to the content type or stage being changed.
- Run `pnpm lint:prompts` when touching prompts.
- Run `pnpm eval:mock` for broad prompt changes.
- Use live evals or `pnpm audit-fidelity <project>` when claiming media-quality improvements.
- Update docs or examples when the expected output contract changes.

If a prompt output schema changes, update validators, fixtures, migrations/backfill scripts, and downstream consumers in the same PR.

## Feature Flags

Per-project feature flags live under `project.features.*` in `project.json`. The registry is `docs/feature-flags.md`.

When adding a flag:

1. Default it to off.
2. Add the field to `ProjectFeatures` in `src/core/project/projectTypes.ts`.
3. Seed the default in `src/server/runners/createProjectInProcess.ts`.
4. Read it through a helper that treats only literal `true` as enabled.
5. Document it in `docs/feature-flags.md`.
6. Add tests for both enabled and disabled behavior.

Do not silently flip existing project behavior with a new default-on flag.

## API and Server Changes

Server/API changes should preserve existing clients unless the PR is explicitly a breaking change.

- Keep endpoints under `/api/v1`.
- Keep WebSocket messages stable or version/guard new fields.
- Update README API docs when adding or changing endpoints.
- Include tests under `tests/server/`, `tests/unit/`, or `tests/e2e/` as appropriate.
- Make cancellation and reconnect behavior explicit for long-running operations.

The server writes discovery data to `~/.dhee/server.json`. Preserve file permissions and compatibility for desktop/external drivers.

## Security and Secrets

This project can execute local workflows, call external providers, and handle user media. Treat that as sensitive.

- Never commit API keys, tokens, `.env`, `.llm-routing.json`, logs, generated projects, or uploaded user media.
- Do not log secrets or full authorization headers.
- Validate file paths before reading, writing, or serving assets. Do not allow path traversal through project names or asset paths.
- Keep generated files inside the project/output directories intended for them.
- Avoid shell interpolation. If a command must be spawned, pass arguments as arrays where possible.
- Make network-provider failures explicit without dumping sensitive request bodies.

## Pull Request Process

Before opening a PR:

1. Rebase or merge the latest `master`.
2. Run the narrow tests for your change.
3. Run `pnpm lint`, `pnpm test`, and `pnpm build`.
4. Run the full suite with `pnpm exec vitest run` for shared pipeline, server, provider, or migration work.
5. Update README/docs/examples when behavior, setup, commands, API, env vars, or feature flags change.

Use Conventional Commit-style titles:

```text
fix(executor): preserve downstream invalidation after redo
feat(workflows): add cloud manifest for ltx23 i2v
test(server): cover websocket cancellation events
docs(prompts): document shot image prompt contract
refactor(providers): isolate Comfy Cloud routing
```

PR descriptions should include:

- What changed and why.
- How to test it.
- Which providers/workflows were exercised, if any.
- Screenshots or short clips for frontend or media-output changes when useful.
- Any known limitations, follow-up work, or migration concerns.

## Issues and Bug Reports

Useful bug reports include:

- OS and Node version.
- `pnpm --version`.
- Whether you used local ComfyUI, Comfy Cloud, LM Studio, OpenRouter/OpenAI, Gemini, or another provider.
- The command or UI action that failed.
- Relevant log excerpts with secrets removed.
- A minimal `.dhee` project fixture or reproduction steps when state matters.

For security-sensitive reports, do not publish secrets, private media, provider keys, or exploit details in a public issue.

## License

This repository is licensed under the GNU Affero General Public License v3.0. By contributing, you agree that your contributions are licensed under AGPL-3.0. See `LICENSE` for the full terms.

If you run a modified version of `dhee-core` as a network service, AGPL requires you to make the complete corresponding source available to users of that service.
