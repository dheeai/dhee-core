# AGENTS.md — dhee-core

Orientation for AI coding agents (Codex, Claude Code, etc.) working in
this repo. Claude Code additionally reads `CLAUDE.md` and auto-loads the
skills under `.claude/skills/`; Codex and other agents that don't read
those should use this file + the referenced guides.

## What this is

**dhee-core** is a content-agnostic generative pipeline engine: a bundle
DAG walker, content-addressed cache, runner registry, and the pi-agent
that drives it. A **bundle** is a dependency graph of typed nodes; each
node runs an LLM or media-generation call via a **runner**; the walker
executes them in dependency order with retries, caching, and cascade
invalidation. The *kind* of output (video, music video, anime storybook,
audio podcast, …) is decided by the nodes + runners — not the engine.

## Where things live

| Thing | Path |
|-------|------|
| Bundle / runner schema | `src/dag/schema.ts` |
| Walker | `src/dag/walker.ts` |
| Runner registry | `src/dag/runners/registry.ts`, registered in `src/dag/runners/index.ts` |
| Runners | `src/dag/runners/` (`comfyExecutor.ts` is the shared Comfy core; `comfyKlein/Tti/Fl2v`, `comfyLtxDirector`, `llmGenerate`, …) |
| Built-in bundles | `src/dag/bundles/` |
| Design docs | `docs/` · Wiki: https://github.com/dheeai/dhee-core/wiki |

## Authoring tasks → read the matching guide

These are the authoritative how-tos (the Claude Code skills; readable as
plain Markdown by any agent):

- **Create a bundle / pipeline** (data only, no TypeScript) →
  `.claude/skills/bundle-authoring/SKILL.md`
  (also: wiki "Bundles Beginner Guide" + "Authoring a Bundle").
- **Write a runner** (the TypeScript module that executes a node) →
  `.claude/skills/runner-authoring/SKILL.md`.
- **Publish a runner/bundle as an npm package** (ESLint-plugin-style:
  `dhee-runner-*` / `dhee-bundle-*`) → `docs/ecosystem-package-conventions.md`.

## Key rules (don't violate)

- **A runner's name is a promise about its code.** Generic name → generic
  code; a runner that knows one workflow's shape must be *named* for it
  (`comfy.klein`, not `comfy.image`). Share plumbing via a helper module
  (`comfyExecutor`), which is **not** a registered runner.
- **Runners return `RunnerResult`, never throw** for expected failures.
- A bundle's `dependencies.runners` must list every tool its nodes use
  (validated against the registry before the walk).
- Tests must exercise real behavior (call functions / run the runner),
  never grep source strings (see `CLAUDE.md`).
- Check `logs/` when debugging.

## Build / test

```bash
pnpm build            # tsup → dist/ (the desktop loads dhee-core from dist)
npx tsc --noEmit -p tsconfig.json
npx vitest run        # full suite
pnpm dhee <verb>      # drive the pipeline headlessly (see the `dhee` skill)
```
