# Verb SDK Split — Apache-2.0 Runner/Bundle Authoring Package

## Problem

The engine is AGPL-3.0. Runners are TypeScript modules that today `import`
directly from engine internals (`src/dag/schema.ts`, the LLM router, the
generation cache, ComfyUI client, etc.). That means any third-party runner
that wants to compile against the current surface effectively links against
AGPL code — making it (arguably) a derivative work, which blocks an
ecosystem of independently-licensed runners and bundles.

We want the ComfyUI-custom-nodes / Blender-add-ons pattern: a small, stable,
**permissively-licensed (Apache-2.0)** authoring package — the **Verb SDK** —
that runner and bundle authors import. Authors depend ONLY on the SDK; they
never import the AGPL engine. The engine depends on the SDK and provides the
runtime implementations behind the SDK's interfaces.

This doc specifies that split. It is a **prerequisite** for distributing
community runners/bundles (e.g. via npm) and is being done in parallel with
the premium-tier runners — the SDK contract must be **frozen first** so those
runners are authored against it from day one (see Sequencing).

## What Already Exists (the contract is mostly here)

The hard design work is largely done. These are already clean and close to
SDK-ready:

- **`Runner` interface** (`src/dag/schema.ts:403`) — `{ describe, run }`. Pure
  contract, no logic.
- **`RunnerContext` / `RunnerResult` / `RunnerDescription`**
  (`src/dag/schema.ts:347-406`) — invocation contract. `RunnerContext`
  already injects `log` (the dependency-injection pattern we want to extend).
- **`RunnerManifest`** (`src/dag/runners/registry.ts:30`) — already explicitly
  documented as "part of the public runner SDK surface… breaking changes here
  require an engine major-version bump." `tool`, `version`, `engineCompat`,
  `credentials[]`, `displayName?`, `description?`, `entry?`.
- **Disk discovery** (`src/dag/runners/discovery.ts`) — scans
  `~/.kshana/runners/<name>/` for `runner.json` (manifest) + an entry module
  exporting `export const runner = {...}`. ComfyUI-style "load what's there,
  name failures, keep going."
- **Bundle → runner dependency declaration** (`BundleDependencies.runners`,
  `src/dag/schema.ts:152`) — `Record<toolName, semverRange>`, validated by
  `RunnerRegistry.validateBundle()` (`registry.ts:112`) before any work runs.

So the registry/manifest/discovery/validation layer is already
ecosystem-shaped. **The split is extraction + a small DI refactor, not a
redesign.**

## What's Missing (the actual work)

### 1. There is no published SDK package
Everything lives in `src/dag/**` inside the AGPL tree. We need a separately
built, separately licensed, separately publishable package.

### 2. Runners reach into the AGPL engine by direct import
Survey of what built-in runners import today (`src/dag/runners/*.ts`):

| Import | Tier | Action |
|---|---|---|
| `../schema.js` (×11) — Runner, RunnerContext, RunnerResult, RunnerDescription, NodeDef, DagBundle… | **Contract** | Move the type-only contracts to the SDK |
| `./registry.js` — `RunnerManifest` type | **Contract** | Move type to SDK (registry *class* stays in engine) |
| `./transientRetry.js` (×3) | **Helper** | Move to SDK (pure utility) |
| `./endpointResolver.js` (×3) — reads `ENDPOINT_<name>` env | **Helper** | Move to SDK (pure utility, no engine dep) |
| `../cas/inputsHash.js` (×3) — content-address input hashing | **Helper** | Move to SDK (so custom runners can participate in the cache key) |
| `../cas/GenerationCache.js` (×3) | **Engine-internal** | **Remove from runners** — caching is the *engine's* job (wrap the runner call); runners stay cache-agnostic |
| `../../core/llm/*` — router, purposes, getVLMConfig, config | **Engine-internal** | **Inject** via `ctx.llm` (SDK-typed interface, engine-implemented) |
| `../../services/comfyui/ComfyUIClient.js` (×3) | **Engine-internal** | Stays in engine; first-party comfy runners stay in engine (AGPL is fine for first-party). NOT an SDK export |
| `../../core/timeline/watermark.js` | **Engine-internal** | Stays in engine (used by first-party ffmpeg runner) |
| `semver`, `openai`, `ajv`, `ajv-formats` | third-party | Runners bring their own; not an SDK concern |

### 3. Capabilities a runner needs at runtime are imported, not injected
This is the heart of the firewall. A third-party runner cannot `import` the
LLM router or the cache without pulling in AGPL code. The fix:

> **Extend `RunnerContext` with engine-injected, SDK-typed capability handles.**
> The SDK defines the *interface*; the engine provides the *implementation* and
> passes it in via `ctx`. The runner never imports the implementation.

Today `ctx.log` already works this way. Add (all optional, runners must
tolerate absence per the existing back-compat discipline):

- `ctx.llm?: LLMAccess` — model access (engine implements via its router).
- `ctx.cache` — **not exposed**; the engine wraps the runner call with the
  input-hash cache, so runners don't touch caching at all. Removing the direct
  `GenerationCache` import is part of this.
- Endpoint resolution: keep `endpointResolver` as a **pure SDK helper** (it
  just reads `ENDPOINT_<name>` env) — no injection needed.

## SDK Surface (what gets published)

Three tiers, by what each thing is:

- **Contract (type-only, MUST be in SDK):** `Runner`, `RunnerContext`,
  `RunnerResult`, `RunnerDescription`, `RunnerManifest`, `NodeDef`,
  `DagBundle`, `BundleDependencies`, `BundleInputDecl`, and every type
  reachable from them. These erase at runtime → zero runtime coupling.
- **Helpers (pure utilities, SHOULD be in SDK):** `defineRunner()` ergonomic
  factory, `transientRetry`, `endpointResolver`, `inputsHash`, a typed `log`
  shim. Apache-2.0, dependency-light, no engine imports.
- **Engine-internal (MUST NOT be importable by third-party runners):** the
  walker, `walkState`, event-sourcing internals, `RunnerRegistry`
  *implementation*, `GenerationCache`, the LLM router, `ComfyUIClient`. These
  stay AGPL in `src/`.

## Package, Build & License

- **Name:** `@dhee/verb-sdk` (see Open Questions on the `kshana`↔`dhee` naming
  split).
- **License:** Apache-2.0. The engine stays AGPL-3.0-or-later. License boundary
  is per-package (standard for mixed-license monorepos).
- **Layout (recommended): monorepo workspace package.** `pnpm-workspace.yaml`
  already exists (currently `packages: [frontend]`). Add `packages/verb-sdk`.
  Contract types move there; `src/dag/schema.ts` etc. **re-export from the SDK**
  so the engine has a single source of truth and no drift. Publish the package
  independently to npm.
- **Dependency direction:** engine `dependencies` → `@dhee/verb-sdk`.
  Third-party runner packages declare `@dhee/verb-sdk` as a
  **peerDependency** (use the host engine's copy; for the mostly-type-only
  surface this is a compile-time concern, so instance-sharing is a non-issue).
- **Build:** SDK ships its own `.d.ts` + ESM. It must build and typecheck with
  **zero imports from `../src`** — that's the firewall, mechanically enforced.

## Forward-Compatibility Constraints (cheap now, breaking later)

1. **Do NOT weld output to a single file.** `RunnerResult` is currently
   `{ ok: true; outputPath; metadata? }`. Keep `outputPath` for v1, but design
   the type so multi-artifact / streaming / non-file outputs can be added as an
   **additive, non-breaking** variant later. Don't write validators that assume
   "exactly one file."
2. **Keep `RunnerResult.metadata` as the structured telemetry channel.**
   Downstream features depend on runners emitting structured per-run metadata
   into the event log. Don't drop or stringify it. (A future `ctx.emit(event)`
   mid-run hook is anticipated — leave room, don't build it now.)
3. **Lock the permission-manifest convention now (enforce later).** Extend the
   manifest beyond `credentials[]` with a declarative permission block so the
   convention is fixed before the first external submission:
   ```jsonc
   "permissions": {
     "network": ["api.example.com"],   // host globs the runner may contact
     "filesystem": "project",          // 'project' | 'none' | 'temp'
     "subprocess": false,              // may it spawn child processes?
     "env": ["EXAMPLE_API_KEY"]        // env it reads (superset of credentials)
   }
   ```
   Sandboxing/enforcement is out of scope here; **only the schema is in scope**,
   so authors and the registry agree on the shape from day one.

## Firewall Acceptance Test (definition of done)

1. A throwaway runner package living **outside the repo**, whose only `dhee`
   dependency is `@dhee/verb-sdk`, **compiles and runs** end-to-end through
   `discoverRunners` from `~/.kshana/runners/`. (This is the firewall proof —
   if it needs anything from `../src`, the split failed.)
2. All 7 existing bundles still validate and run unchanged
   (`narrative_prompt_relay`, `narrative_shot_by_shot`, `narrative_text_only`,
   `narrative_text_video`, `narrative_qwen_chain_relay`,
   `narrative_qwen_chain_review`, `narrative_klein_relay_review`).
3. `tsc` on the `packages/verb-sdk` project has **zero references to `../src`**.
4. At least one **premium-tier runner** (built in parallel) is authored
   SDK-only as live proof, not just the throwaway.

## Touch Points

- `packages/verb-sdk/` (new) — contract types + helpers + `package.json`
  (Apache-2.0).
- `pnpm-workspace.yaml` — add the package.
- `src/dag/schema.ts` — move contract types out; re-export from SDK.
- `src/dag/runners/registry.ts` — `RunnerManifest` type → SDK; class stays.
- `src/dag/runners/{transientRetry,endpointResolver}.ts`,
  `src/dag/cas/inputsHash.ts` — relocate to SDK helpers.
- `src/dag/runners/llmGenerate.ts`, `vlmJudge.ts` — migrate LLM/VLM access
  from direct router import to `ctx.llm`.
- `src/dag/walker.ts` — own the input-hash cache wrap so runners drop the
  `GenerationCache` import.
- `src/dag/runners/discovery.ts` — no change to behavior; verify the manifest
  type now sourced from SDK.

## Non-Goals (this doc)

- Sandboxing / actually enforcing the permission manifest (schema only).
- The npm publish/curation pipeline and 3-tier marketplace policy (separate
  doc; SECURITY/permission policy must precede first external submission).
- Authoring the premium-tier runners themselves (separate docs).
- Migrating *every* built-in runner to SDK-only (see P0/P1 below).

## Sequencing (P0 / P1)

- **P0 — freeze + publish the contract.** Extract contract types + helpers into
  `@dhee/verb-sdk`; add `ctx.llm`; remove the cache import from the runner path;
  publish a `0.x`. Pass acceptance tests 1–3. This is the hard freeze both the
  SDK branch and the premium-runner branch build against.
- **P1 — dogfood.** Migrate all built-in runners to author against SDK-only
  (so the engine eats its own dog food — if a built-in can't be written with
  only the SDK, neither can a community runner). Can land after P0.

## Estimated Effort

Framed agent-days-to-verified (authoring is cheap; the cost is regression
verification against the 7 existing bundles, not lines of code):

- Contract extraction + package/build/license wiring: **~1 day-to-verified.**
- Capability-injection refactor (`ctx.llm`, cache-to-walker, endpoint helper):
  **~1–2 days-to-verified** — dominated by re-running the existing bundles, not
  the edit.
- Firewall acceptance harness (out-of-tree runner): **~0.5 day.**
- **P0 total: ~2.5–4 days-to-verified.** P1 (migrate all built-ins) is
  additive and can lag.

## Open Questions (for founder)

1. **Naming.** Public brand is `@dhee/*`, but the runtime uses `~/.kshana/`
   and `dhee-core`'s local checkout is `kshana-core`. Reconcile to `@dhee/`
   (recommended) — and decide separately whether `~/.kshana/runners/` gets
   renamed/aliased (out of scope here, but it's a visible inconsistency).
2. **Monorepo package vs separate repo.** Recommended: monorepo workspace
   package (co-located contract, no cross-repo drift, per-package license).
   Separate repo is the alternative if independent release cadence is wanted.
3. **How much of LLM access to expose via `ctx.llm`.** Minimal (single
   `generate(prompt, opts)`), or the fuller tiered/purposes routing the
   built-in `llmGenerate` uses? Recommend starting minimal; widen on demand.
4. **CLA policy** for external runner/bundle contributions (load-bearing; not
   blocking the SDK code itself but should be decided before submissions open).
