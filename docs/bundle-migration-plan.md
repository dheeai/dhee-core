# Bundle Migration Plan

**Decision date:** 2026-05-27
**Owner:** Ganaraj Permunda
**Status:** Proposed — pending approval before implementation
**Target completion:** ~2 weeks of focused work

---

## 1. Decision

Replace the hybrid (legacy ExecutorAgent + DAG bundle) production architecture
with a single-architecture, all-bundle production system. The decision is
prompted by a week of accumulated glue-code bugs at the executor↔bundle boundary
(`saveProject` whitelist stripping `renderMethod`, `process.cwd()` path resolution
breaking under desktop, `executeRunTo` bypassing the dispatcher, stage-vocabulary
mismatch causing shot-by-shot fallback on prompt_relay projects). Each was real
and fixable, but they're symptoms of a structural problem: two production
vocabularies pretending to be one.

The chosen replacement is the **ComfyUI mental model**:

- **Engine** (the walker) walks a DAG. Doesn't know "narrative" from "documentary."
- **Runners** are the work-doers (LLM call, Comfy image, Comfy video, ffmpeg).
  Built-in runners ship with kshana-core. **Custom runners are user-installable**,
  same as ComfyUI custom nodes.
- **Bundles** are user-authored production pipelines — JSON DAGs + prompts +
  workflows, packaged as directories. The bundles we ship (narrative_classic,
  narrative_relay) are reference implementations; users can copy, customize, and
  eventually share them.

After migration:

- One production path. No dispatcher. No stage-vocabulary translation.
- New project type (documentary, music video, explainer, …) = JSON file.
- New capability (Suno, Runway gen-3, Eleven Labs TTS, …) = installable runner package.
- Engineering bottleneck removed from "what kshana can produce."

## 2. Architecture overview

### 2.1 Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              pi-agent                                   │
│  dhee_run_to    dhee_invalidate    dhee_status    dhee_show_*           │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            walker (engine)                              │
│  loadBundle  →  validateAgainstRegistry  →  walk(state, stopAt, runOnly)│
│  emits events: onNodeStart, onNodeComplete, onAsset, onLog              │
└──────┬──────────────────────────────────────────────────────────────┬───┘
       │                                                              │
       ▼                                                              ▼
┌──────────────────────────────┐                  ┌───────────────────────┐
│      RunnerRegistry          │                  │   Bundle (directory)  │
│  built-in:  llm.generate     │                  │   bundle.json (DAG)   │
│             comfy.image      │                  │   prompts/*.md        │
│             comfy.ltx_director                  │   schemas/*.json      │
│             ffmpeg.concat    │                  │   workflows/*.json    │
│             audio.analyze ... │                  └───────────────────────┘
│  custom:    runway.gen3      │
│             suno.music ...   │
└──────────────────────────────┘
```

### 2.2 Bundle location resolution

A project's `project.json` carries:

```json
{
  "bundleSource": "built-in:narrative_relay"
}
```

Resolved by the walker via a single helper, with three schemes:

| Scheme | Location | Example |
|---|---|---|
| `built-in:<id>` | `<REPO_ROOT>/src/dag/bundles/<id>/` | `built-in:narrative_relay` |
| `user:<id>` | `~/.kshana/bundles/<id>/` | `user:my_studio_doc` |
| `registry:<scope>/<name>@<version>` | future bundle registry | `registry:studio42/explainer@1.2.0` |

`renderMethod` as a top-level project field is **deleted**. `bundleSource` is the new single source of truth for "what this project produces."

### 2.3 Runner registry

```ts
// src/dag/runners/registry.ts
export class RunnerRegistry {
  register(manifest: RunnerManifest, runner: Runner): void;
  get(tool: string): Runner | undefined;
  list(): RunnerManifest[];
  validateBundle(bundle: DagBundle): ValidationResult;
}
```

Discovery at startup:

1. Compile-time: all built-in runners auto-register on import.
2. Runtime: walker scans `~/.kshana/runners/` for `runner.json` manifests, dynamic-imports each, calls `register()`.
3. Runtime override: `KSHANA_RUNNER_PATH` env var allows additional dirs (testing, monorepo, CI).

### 2.4 Bundle manifest with dependencies

Every `bundle.json` declares:

```json
{
  "id": "narrative_relay",
  "version": "1.0.0",
  "engineCompat": ">=1.0.0 <2.0.0",
  "dependencies": {
    "runners": {
      "llm.generate":        ">=0.1.0",
      "comfy.image":         ">=0.1.0",
      "comfy.ltx_director":  ">=0.1.0",
      "ffmpeg.concat":       ">=0.1.0"
    }
  },
  "goal": "final_video",
  "nodes": [...]
}
```

Walker validates **before** running:
- All declared runners are registered.
- Each registered version satisfies the declared range.
- Required credentials (declared by each runner) are present in the environment.

Fails loudly with install hints on miss.

### 2.5 Runner SDK (`@kshana/runner-sdk`)

Exported as a stable public sub-package. Third parties build against this.

```ts
// @kshana/runner-sdk
export interface Runner {
  readonly tool: string;
  readonly version: string;
  configSchema(): JsonSchema;
  run(ctx: RunnerContext): Promise<RunnerResult>;
}

export interface RunnerContext {
  bundleDir: string;          // absolute path — for resolving promptTemplate, workflowPath
  projectDir: string;
  nodeId: string;
  itemId?: string;
  config: Record<string, unknown>;
  inputs: Record<string, ResolvedInput>;
  outputPath: string;
  signal?: AbortSignal;
  emit(event: RunnerEvent): void;     // log, partial output, progress
}

export interface RunnerResult {
  ok: boolean;
  outputPath?: string;
  outputs?: Record<string, string>;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

Semver discipline from day 1. Breaking changes to this interface = major version bump.

### 2.6 walkState replaces executorState

Per-project DAG state, written by the walker after every node completion:

```json
{
  "bundleSource": "built-in:narrative_relay",
  "bundleVersion": "1.0.0",
  "engineVersion": "1.0.0",
  "nodes": {
    "story":                              { "status": "completed", "outputPath": "plans/story.md",      "completedAt": 17... },
    "character:naia":                     { "status": "completed", "outputPath": "characters/naia.md" },
    "shot_image:scene_1_shot_3":          { "status": "completed", "outputPath": "assets/images/..." },
    "scene_clip:scene_1_chunk_1":         { "status": "pending"   },
    "final_video":                        { "status": "pending"   }
  },
  "lastInvalidatedIds": []
}
```

Same per-node shape as today's `executorState`, just owned by the walker. **No whitelist serializer.** Walker reads/writes this section of `project.json` directly. No drift possible.

## 3. Migration phases

Each phase has explicit failure-mode enumeration before coding (per the project's
TDD rule). Tests for those failure modes are written first.

### Phase 0 — Foundation (2 days)

**Goal:** Runner SDK, dynamic registry, bundle source resolver, dependency validation.

**Failure modes to test:**

1. Bundle declares a runner that isn't registered → clear error, install hint.
2. Bundle declares runner version range no registered runner satisfies → clear error.
3. Bundle source URI is malformed (`builtin:x` not `built-in:x`) → clear error.
4. `built-in:foo` references a missing bundle directory → clear error.
5. `user:foo` references a missing bundle directory → clear error.
6. `~/.kshana/runners/foo/runner.json` is malformed JSON → log warning, skip, continue startup (one bad runner doesn't kill the engine).
7. Two runners declare the same `tool` id → log warning, last-loaded wins (deterministic behavior to be picked, but never silent).
8. Required credential env var declared by a runner is missing → bundle validation fails before walking.
9. Concurrent `register()` calls → registry is thread-safe (single-process, but consistent).

**Tests written first:** all of the above as `tests/dag/registry.test.ts` and `tests/dag/bundleSource.test.ts`.

**Implementation:**
- `src/dag/runners/registry.ts` — class with `register/get/list/validate`.
- `src/dag/bundleSource.ts` — URI parser + dir resolver.
- `src/dag/runners/discovery.ts` — startup scanner for `~/.kshana/runners/`.
- Refactor existing `src/dag/runners/index.ts` to register through the new registry.
- Update walker entrypoint to call validator before walking.

**Done when:**
- All Phase 0 tests pass.
- Existing bundle tests still pass (no regressions on the existing prompt_relay path).

---

### Phase 1 — `llm.generate` runner (1.5 days)

**Goal:** A runner that handles every LLM call the narrative bundle needs: prose, JSON, schema-validated JSON, with tier routing (heavy/medium/light).

**Failure modes to test:**

1. LLM call times out → retry N times per config; on final failure, return `{ ok: false, error }` cleanly.
2. LLM returns malformed JSON when `outputFormat: "json"` declared → attempt repair (existing `repairJson` utility), then fail clearly with the raw output captured.
3. JSON output fails schema validation → return clear error showing which fields failed.
4. Prompt template references a variable that isn't in `ctx.inputs` → fail at substitution time, name the missing variable.
5. Prompt file path doesn't exist (`promptTemplate: "prompts/missing.md"`) → fail at runner.run with clear file-not-found.
6. Output file already exists and `forceRerun` is false → skip, return existing outputPath, emit "cached" event.
7. Output file exists but is empty/zero bytes → treat as missing, re-run.
8. AbortSignal fires mid-call → cancel LLM request, return `{ ok: false, error: "aborted" }`.
9. Tier is unrecognized (e.g. `tier: "ultra"`) → fail at config-schema validation, not at runtime.
10. The LLM returns an empty response → fail loudly with that exact message (per the "be transparent in the UI" rule).

**Tests written first:** `tests/dag/runners/llmGenerate.test.ts` with stubbed LLM client.

**Implementation:**
- `src/dag/runners/llmGenerate.ts` — implement `Runner` interface.
- Internally uses the existing `LLMRouter` (`src/core/llm/`) so heavy/medium/light tier routing is consistent with current production.
- Prompt substitution: simple `{{var_name}}` replacement from `ctx.inputs`.
- JSON output: parse → repair-if-needed → schema-validate.

**Done when:** Phase 1 tests pass. Stubbed end-to-end test produces a markdown output and a schema-valid JSON output from a tiny test bundle.

---

### Phase 2 — `comfy.image` runner (1.5 days)

**Goal:** A runner that drives Klein (Flux Klein KV) for first frame / last frame / reference image generation. Replaces the executor's image handler.

**Failure modes to test:**

1. Comfy endpoint unreachable → fail with the resolved URL in the error message (NOT the bundle's semantic name).
2. Workflow JSON path doesn't exist → fail at runner.run with clear error.
3. Workflow expects a model file that isn't on the Comfy server → surface Comfy's actual error verbatim (don't swallow).
4. More than 4 reference images supplied → reject at config validation (Klein cap).
5. WebSocket disconnects mid-render → fall back to HTTP polling (existing pattern in `ComfyUIClient`).
6. Output path already exists → skip (skip-if-output-exists).
7. Klein output file isn't named what the workflow declared → search the most-recent matching output (existing `findLatestImageOutput` utility).
8. Endpoint env var (`ENDPOINT_self_local`) is missing → fail bundle validation in Phase 0 (with hint).
9. AbortSignal fires during a render → cancel the Comfy job AND the WS connection.

**Tests written first:** `tests/dag/runners/comfyImage.test.ts` with a stubbed Comfy server (in-process HTTP/WS mock).

**Implementation:**
- `src/dag/runners/comfyImage.ts`.
- Reuses `ComfyUIClient` (no changes needed there).
- Pattern follows `comfyLtxDirector.ts` (already shipped) for endpoint resolution.
- Klein workflow template injection: prompt text, reference image paths, output filename.

**Done when:** Phase 2 tests pass. Manual test against the user's local Comfy generates one image successfully.

---

### Phase 3 — `narrative_relay` bundle authoring (2 days)

**Goal:** Translate the existing narrative pipeline into a complete bundle directory. This is **extraction, not authoring** — every prompt and schema already exists in the codebase; the work is mechanical translation to files.

**Failure modes to test (parity tests):**

1. Run the bundle on a fresh project (a duplicate of "Out of this world") through Phase 5 walker. Assert: every output file matches the legacy-executor-produced version byte-for-byte for deterministic outputs (Klein with same seed = bit-identical; LLM with same prompt + same model = textually identical modulo whitespace).
2. Run the bundle on a partially-completed project. Assert: skip-if-output-exists keeps existing outputs, only renders the pending.
3. Run the bundle with `runOnly: ["shot_image:scene_1_shot_3"]` (single-node invalidation). Assert: only that node and its dependents re-run.
4. Run the bundle with `stopAt: "character_image"`. Assert: walker stops after that node type completes; downstream stays pending.
5. Cancel mid-run. Assert: walkState reflects "in_progress → pending" for the interrupted node, no orphaned partial files (the runner is responsible).

**Implementation:**
- Create `src/dag/bundles/narrative_relay/` directory.
- Extract each LLM prompt from the corresponding template/handler TypeScript file into `prompts/<typeId>.md`. The prompt strings already exist; the work is "move to file, replace template literal vars with `{{var_name}}`."
- Extract each output schema (where one exists today) into `schemas/<typeId>.schema.json`.
- Author `bundle.json` mirroring the existing narrative DAG, node by node. Use the mockup from this plan's earlier discussion as the structural template.
- Copy/symlink the existing `workflows/built-in/klein_fluxkv.json` and `workflows/built-in/ltx23_director_chain_local.json` into the bundle dir (bundle-local for isolation; we'll consider shared/ later).
- Also create `src/dag/bundles/narrative_classic/` — same as relay, but the video subtree uses `shot_video` nodes per shot (one Comfy LTX FL2V call each) instead of `scene_clip` per chunk. The upstream nodes (story → shot_image) are shared. Bundle JSONs duplicate the upstream nodes; we accept the duplication for now over premature abstraction.

**Done when:** Parity test against "Out of this world" passes. The new bundle produces an indistinguishable final video on the same input.

---

### Phase 4 — Walker enhancements (1 day)

**Goal:** Bring the existing walker to feature parity with what the executor offers today: `stopAt`, `runOnly` (invalidation), persistent walkState in project.json, event stream.

**Failure modes to test:**

1. `stopAt: "story"` on a fresh project → only `story` (and its upstream `story_essence`/`plot`/`story_input`) runs; everything downstream stays pending in walkState.
2. `stopAt: "shot_image"` on a partially-completed project → walker resumes from where walkState says, stops after shot_image, leaves shot_video pending.
3. `runOnly: ["shot_image:scene_1_shot_3"]` → only that node and its direct dependents (via cascade) re-run.
4. walkState already has a node marked `in_progress` from a crashed prior run → walker treats it as pending and re-attempts.
5. walkState is malformed JSON → log warning, reinitialize from bundle, mark all nodes pending.
6. Bundle's DAG structure changed between runs (a node was renamed) → walkState entries for missing nodes are dropped with a warning; new nodes start pending.
7. Concurrent walks on the same project → second walk fails fast (use existing lock pattern from executor).

**Tests written first:** `tests/dag/walkerEnhanced.test.ts`.

**Implementation:**
- Extend `walkBundle()` opts: `{ stopAt?: string, runOnly?: string[], onEvent?: (e: WalkerEvent) => void }`.
- Add `loadWalkState(projectDir)` and `saveWalkState(projectDir, state)` helpers; write atomically (temp file + rename).
- Walker reads walkState on entry, updates after every node completion, persists on exit (success, error, or cancel).
- Event stream: `node_started`, `node_completed`, `node_failed`, `asset_produced`, `log`. Replaces the executor's current hook callbacks.

**Done when:** Phase 4 tests pass. The parity tests from Phase 3 use these features.

---

### Phase 5 — Agent + dispatch migration (1.5 days)

**Goal:** Replace the runProjectInProcess dispatcher with a thin walker-invoker. Update pi-agent tools to speak the bundle vocabulary.

**Failure modes to test:**

1. `dhee_run_to project=X` (no stage) → walker runs to bundle's goal node.
2. `dhee_run_to project=X stopAt=character_image` → walker stops there.
3. `dhee_run_to project=X stopAt=unknown_node_id` → fail with the bundle's actual node list in the error.
4. `dhee_invalidate project=X nodeId=shot_image:scene_1_shot_3` → walkState entry flipped to pending; dependents cascaded per existing semantics.
5. `dhee_run_to project=X scope=last_invalidated` → walker runs only `walkState.lastInvalidatedIds`.
6. `dhee_status project=X` → returns walkState summary (per-node counts, current pending, current goal node).
7. Project on disk has `executorState` but no `walkState` (a project from before migration) → see Phase 6 cutover policy.

**Implementation:**
- Delete `src/server/runners/runProjectInProcess.ts`. Replace with a 30-line `runProjectViaBundle(projectDir, opts)` that: loads bundle, validates, runs walker, returns result.
- `executeRunTo` in `backgroundTaskRunnerSingleton.ts` now calls `runProjectViaBundle`.
- Update `dhee_run_to`'s schema: rename `stage` → `stopAt` (more honest); description points at the bundle's nodes, not a hardcoded VALID_STAGES list.
- Update `dhee_invalidate` — already uses node IDs; just verify the docstring examples still match the bundle vocabulary (they do, names are identical).
- Update `dhee_status` to read walkState.
- Update `dhee_show_*` tools to resolve output paths via the bundle's `outputs.pattern` rather than hardcoded paths.

**Done when:** Phase 5 tests pass. Manual smoke test through the desktop: new project, configure, "run" works end-to-end.

---

### Phase 6 — Deprecation + cleanup (1 day)

**Goal:** Delete the legacy code paths. Decide explicitly how existing in-flight projects on disk are handled.

**Cutover policy:** **Hard cutover, no converter.** Existing projects with `executorState` and no `bundleSource` field display a "this project predates the bundle migration; finish it on the legacy build (v0.x) or restart it on v1.0" message in the UI. Converters rot, and the user base is small enough that hard cutover is honest.

**Deletions:**
- `src/core/planner/ExecutorAgent.ts`
- `src/core/planner/DependencyGraphExecutor.ts`
- `src/server/runners/runExecutor.ts`
- `src/server/runners/runProjectInProcess.ts`
- `src/core/planner/stages.ts` (VALID_STAGES, STAGE_ALIASES)
- `src/server/runners/classifyRunTarget.ts`
- `saveProject`'s field whitelist in `src/tasks/video/workflow/ProjectManager.ts` (replaced by walker-owned walkState writes; project.json's other fields remain handled by a small whitelist or, ideally, a pass-through serializer)
- The `renderMethod` field handling in `src/core/project/renderMethods.ts` (replaced by `bundleSource`)
- `runRegenInProcess` in ConversationManager (subsumed by walker `runOnly`)

**Tests to keep passing:**
- All bundle/walker tests from Phases 0–5.
- The non-executor tests in `tests/workflow/ProjectManager.test.ts` (the executor-state preservation tests get rewritten as walkState preservation tests; the new "preserves renderMethod" and "preserves features" tests become "preserves bundleSource" + walkState).

**Done when:** `pnpm tsc --noEmit` is clean; `pnpm vitest run` is green; no references to deleted modules remain.

---

### Phase 7 — Verification + docs (1 day)

**Goal:** End-to-end verification on real projects + ship the public docs.

**E2E tests:**

1. **Fresh project, narrative_relay, end-to-end on local Comfy.** Wizard → walker walks → final video lands. Compare against the OOTW reference quality baseline.
2. **Fresh project, narrative_classic, end-to-end on local Comfy.** Same shape.
3. **Surgical regen.** Pick a shot, `dhee_invalidate shot_image:scene_1_shot_3`, run, verify only that shot's first frame re-rendered and downstream chunk re-stitched.
4. **Stop / resume.** `stopAt=character_image`, walker pauses; user calls `dhee_run_to` again with no stopAt; walker resumes and completes.
5. **Cancel mid-render.** Kill the desktop process; restart; verify walker resumes cleanly with no orphan files.

**Docs to ship (under `docs/`):**

- `docs/bundles.md` — what a bundle is, how to author one, file layout, runner reference.
- `docs/runners.md` — what a runner is, the SDK contract, how to write a custom runner, registration.
- `docs/migration-from-v0.md` — for anyone using the legacy executor builds, what changed and why.

**Done when:** all five E2E scenarios pass; the docs render; the user can hand the docs to a hypothetical third party who could write their own runner against them.

---

## 4. Total scope

| Phase | Days | Owner |
|---|---|---|
| 0. Foundation (registry + SDK + bundle source) | 2.0 | Claude / Ganaraj |
| 1. `llm.generate` runner | 1.5 | Claude / Ganaraj |
| 2. `comfy.image` runner | 1.5 | Claude / Ganaraj |
| 3. `narrative_relay` + `narrative_classic` bundles | 2.0 | Claude / Ganaraj |
| 4. Walker enhancements | 1.0 | Claude / Ganaraj |
| 5. Agent + dispatch migration | 1.5 | Claude / Ganaraj |
| 6. Deprecation + cleanup | 1.0 | Claude / Ganaraj |
| 7. Verification + docs | 1.0 | Claude / Ganaraj |
| **Total (focused work)** | **~11.5 days** | |

These are Claude-Code days as established in project memory — orchestration-heavy
work wrapping existing services. Real wall-clock will depend on review cadence
and any failures we surface during parity testing.

## 5. Acceptance criteria

The migration is complete when **all** of these are true:

1. A new narrative project created via the desktop wizard runs end-to-end on the new architecture and produces an OOTW-equivalent (or better) final video.
2. The current "Out of this world" project, re-run via the new architecture, produces an indistinguishable final video from the existing reference.
3. `dhee_run_to`, `dhee_invalidate`, `dhee_status`, `dhee_show_*` all work as documented in their tool descriptions, using bundle node IDs.
4. A custom runner can be installed at `~/.kshana/runners/<name>/` and used by a bundle without modifying kshana-core.
5. No code references `ExecutorAgent`, `DependencyGraphExecutor`, `runExecutor`, `runProjectInProcess`, `VALID_STAGES`, or `classifyRunTarget` anywhere in the live tree.
6. `pnpm tsc --noEmit` clean; `pnpm vitest run` green.
7. The three doc files (`docs/bundles.md`, `docs/runners.md`, `docs/migration-from-v0.md`) are shipped and reviewed.

## 6. Out of scope (explicit)

These are tempting and adjacent, but deferred to keep the migration shippable:

- **Visual bundle editor.** ComfyUI has one; we don't, and authoring JSON in a text editor is acceptable for v1.
- **Bundle registry / marketplace.** `registry:` URIs are reserved in the schema but not implemented.
- **Runner package manager.** Users install custom runners by cloning into `~/.kshana/runners/`; we don't ship a `kshana runner install <pkg>` CLI yet.
- **Runner sandboxing / permissions.** Custom runners run with the same trust as kshana-core. No process isolation.
- **Bundle hot-reload.** Walker reads the bundle on each invocation; no live-edit pickup mid-walk.
- **Schema migration for old projects.** Hard cutover; no automated conversion of legacy `executorState` → `walkState`.
- **Audio runner family** (`audio.analyze`, `audio.transcribe`, `tts.generate`). Music-video-bundle dependencies. Built as separate work after this migration lands.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Parity test reveals nondeterminism in LLM outputs that breaks bit-exact comparison | Accept text-normalized comparison (whitespace + trailing newline tolerance); manually inspect the rare actual-content drifts |
| Walker walkState shape vs existing executorState shape divergence breaks invalidation cascade | Phase 4 explicitly mirrors the cascade semantics; Phase 5 tests exercise it |
| A built-in runner's config schema can't express something the executor handler did implicitly | Phase 1/2 failure-mode tests are the bottleneck; uncover during build, not during migration |
| `process.cwd()` or similar latent path bugs in untouched code surface after the cutover | Phase 7 E2E test from a clean desktop catch-all; the bundle/workflow path bug from this week is already covered by `tests/dag/bundle-paths.test.ts` |
| Custom runner discovery introduces a startup performance regression | Bench-test scan of `~/.kshana/runners/` with N=100 stubs; if measurable, switch to lazy load with manifest pre-scan |
| Bundle versioning (engineCompat) too strict; legitimate runs blocked | Engine compares only major version for v1; minor/patch are accepted always |

## 8. Open questions

1. **Where does the `LLMRouter` (heavy/medium/light tier config) live?** Today it's in `src/core/llm/`. Bundles need to declare a tier per LLM node. Does the LLMRouter stay as engine-level config (settings.json), with bundles just passing `tier: "heavy"` strings? Yes — this is the cleanest split: routing is per-user infrastructure, not per-bundle. Confirmed.

2. **Comfy endpoints: per-bundle or per-user?** Per-user (the `comfyEndpoints` settings dict we already have). Bundles reference endpoints by semantic name (`self.local`, `public.cloud`). Already aligned with the existing system. No change.

3. **Where does `world_style` resolution live?** Today it's an LLM-derived stylistic guide consumed by many downstream nodes. In the bundle it's just another `llm.generate` node with `scope: project`. No special handling needed.

4. **Are bundles versioned independently from kshana-core?** Yes. A bundle is a directory with a `version` field. The engine has its own version. `engineCompat` declares what the bundle was authored against.

5. **Do we ship a bundle linter / validator CLI?** Nice-to-have. Out of scope for the migration; add later.

6. **Migration of `project.features.*` (skipHoldingBeatLF and friends)?** Bundles can read project.features in their node configs (template substitution). Phase 3 verifies via the parity test (skipHoldingBeatLF is in the OOTW reference).

## 9. First commit after approval

Phase 0, single commit, scope:

- `@kshana/runner-sdk` types extracted into a separate export (no implementation changes yet).
- `RunnerRegistry` class created; existing runners migrated to register through it (no behavior change).
- `bundleSource` URI parser added.
- All Phase 0 failure-mode tests added — written BEFORE the implementation, expected to be red until the implementation lands.

After approval, this is the first thing built.

---

**Sign-off needed from Ganaraj before Phase 0 starts.**
