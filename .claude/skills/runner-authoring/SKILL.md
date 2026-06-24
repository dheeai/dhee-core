---
name: runner-authoring
version: 1.0.0
description: |
  Write a NEW dhee-core runner (the TypeScript module that executes one
  node) or refactor an existing one. Use when the user wants to "add a
  runner", "wire a new model / API / backend into the pipeline", "make a
  ComfyUI workflow runnable as a node", "support a new output modality
  (audio/TTS/music/3D)", or "split / rename a runner". Covers the Runner
  contract, the bound-vs-generic naming decision, reusing the shared
  comfyExecutor for Comfy workflows, registration, credentials, and
  testing. For wiring EXISTING runners into a pipeline (no TypeScript),
  use the bundle-authoring skill instead.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Authoring a dhee-core runner

A **runner** is the TypeScript module that executes ONE node. The walker
resolves a node's inputs, then calls the runner registered under that
node's `runner.tool`. Runners live in **`src/dag/runners/`** and are
registered in **`src/dag/runners/index.ts`**.

> **The load-bearing rule (learned the hard way):** a runner's *name* is a
> promise about its *code*. A generically-named runner (`comfy.image`)
> must contain only generic code. The moment it needs to know a specific
> workflow's node graph, it has lied — split it into a runner *named for
> the workflow it drives* (`comfy.klein`, like `comfy.ltx_director`) and
> push the shared plumbing into a helper module. **Binding is fine; a
> generic name hiding bound code is not.**

---

## Catalog — runners that exist today

> Refresh the registered list anytime:
> ```bash
> grep -oE "tool: '[a-z.]+_?[a-z]*'" ~/Projects/dhee-core/src/dag/runners/index.ts | sort -u
> ls ~/.kshana/runners/          # external dhee-runner-* packages installed locally
> ```

**Built-in / core** — code in `dhee-core/src/dag/runners/`, registered in
`index.ts`. (Bound = legitimately knows one workflow family; Generic =
behavior independent of workflow.)

| tool | file | kind | does |
|------|------|------|------|
| `llm.generate` | `llmGenerate.ts` | generic | text / JSON generation (`tier`, `outputSchema`) |
| `comfy.tti` | `comfyTti.ts` | bound | text→image (Z-Image etc.), no refs |
| `comfy.klein` | `comfyKlein.ts` | bound | Flux-2 Klein reference-edit (base + ≤3 refs; prunes absent ref branches) |
| `comfy.fl2v` | `comfyFl2v.ts` | bound | first/last-frame → video |
| `comfy.ltx_director` | `comfyLtxDirector.ts` | bound | LTX-2 multi-shot relay + talking-head lipsync. **Audio-driven clip length, clamped ~41s; hard 1000-frame cap PER RUN** |
| `comfy.qwen_edit_chain` | `comfyQwenEditChain.ts` | bound | iterative edit-chain shots |
| `ffmpeg.concat` | `ffmpegConcat.ts` | generic | stitch clips + xfade; passes each clip's own audio. **No music-bed/`amix` mixing** |
| `ffmpeg.shot_clip` | `ffmpegShotClip.ts` | generic | build a single shot clip |
| `ffmpeg.kenburns` | `ffmpegKenBurns.ts` | generic | pan/zoom (Ken Burns) over a still/clip |
| `ffmpeg.overlay` | `ffmpegOverlay.ts` | generic | composite an image over a video (real-pixel card/inset) |
| `ffmpeg.demo_overlay` | `ffmpegDemoOverlay.ts` | generic | talking-head + screenshot pop-in/expand choreography |
| `vlm.judge` | `vlmJudge.ts` | generic | pass/fail review of an image (review-loop bundles) |

**External packages** — `dhee-runner-*`, discovered ESLint-plugin-style.
For the RUN path they must be symlinked into `dhee-core/node_modules/`
(see project CLAUDE.md "Runner discovery"); source lives in `~/.kshana/runners/`.

| tool | package | installed in `~/.kshana/runners/`? | does |
|------|---------|-----------------------------------|------|
| `comfy.tts` | `@dhee_ai/runner-tts` | ✅ | Qwen3 voice-clone TTS (any language; `language` is a workflow-node field set via `fields`, not a runner param; no text-length cap / no chunking) |
| `comfy.matte` | `dhee-runner-matte` | ✅ | SAM-3 concept-prompted matte (extract product/subject) — CPU |
| `comfy.boogu` | `dhee-runner-boogu` | ✅ | model composite / place a subject into a scene |
| `comfy.vace_place` | `dhee-runner-vace` | ✅ | Wan-VACE: generate scene+motion around a kept subject |
| `cv.track_replace` | `dhee-runner-track-replace` | ❌ declared by `ugc_ad_product_v3/v4`, `ugc_ad_tub` | per-frame homography re-paste of a real label (CPU, no GPU) |
| `cv.cylinder_wrap` | `dhee-runner-cylinder` | ❌ declared by `ugc_ad_tub` | wrap a real label on a rotating cylinder |

For which bundles use which runner, see the **bundle-authoring** skill's
"Catalog — bundles that exist today."

---

## 1. The contract (`@dhee/runner-sdk`)

The canonical types + primitives live in **`@dhee/runner-sdk`**
(`packages/runner-sdk`); `src/dag/schema.ts` re-exports them. In-repo
runners may import from either, but a **published / external** runner
imports ONLY `@dhee/runner-sdk` (the firewall test enforces this).

A runner is just an object with two methods (wrap it in the SDK's
`defineRunner` for inference + intent):

```ts
import { defineRunner } from '@dhee/runner-sdk';
import type { RunnerContext, RunnerResult } from '@dhee/runner-sdk';

export const runner = defineRunner({
  describe: () => ({ /* RunnerDescription */ }),
  run: async (ctx: RunnerContext): Promise<RunnerResult> => ({ ok: true, outputPath: '…' }),
});
```

Two capabilities the SDK adds to `ctx` / the result / the manifest:
- **`ctx.llm`** (`LLMAccess`) — call `ctx.llm.generateText({ messages, tier })`
  instead of importing a provider; the walker injects it. Essential for
  sandboxed/external runners that must not reach into core.
- **`RunnerResult.outputs?: RunnerArtifact[]`** — emit more than the single
  `outputPath` when a runner produces several artifacts.
- **`RunnerManifest.permissions`** — declare the capability surface
  (`network` / `filesystem` / `subprocess` / `env`). Declarative today
  (surfaced by `checkBundleRunners`); runtime sandboxing is future work.

**`RunnerContext`** — what `run` receives:
```ts
{
  projectDir: string;            // absolute project dir; write outputs under here
  bundleDir?: string;            // absolute bundle dir; resolve config file paths against this
  node: NodeDef;                 // the node being run (config at node.runner.config)
  itemId?: string;               // for collection items, e.g. 'scene_1_shot_3'
  inputs: Record<string, unknown>; // resolved upstream inputs (paths / parsed JSON / lists)
  signal?: AbortSignal;          // cooperative cancel — thread it to network/subprocess calls
  log: (msg: string) => void;    // CLI + project log
}
```

**`RunnerResult`** — what `run` returns. **Never throw for an expected
failure** — return the error variant; the walker reads the result:
```ts
type RunnerResult =
  | { ok: true;  outputPath: string; metadata?: Record<string, unknown> }
  | { ok: false; error: string };   // actionable message (name the file/model/input)
```

**`RunnerDescription`** — returned by `describe()` (discovery / UX):
```ts
{ id, displayName, description, capabilities: string[],
  modalities: { input: (...)[]; output: (...)[] },
  configSchema: Record<string, unknown>, costHint?: 'free'|'paid_api'|'local_gpu'|'cloud_gpu' }
```

**`RunnerManifest`** (`src/dag/runners/registry.ts`) — registration record:
```ts
{ tool: string,             // dot-namespaced id, e.g. 'comfy.klein', 'runway.gen3'
  version: string,          // semver
  engineCompat: string,     // semver range
  credentials: string[],    // required env vars; bundles using this fail validation if unset
  displayName?, description? }
```

---

## 2. Decide: bound or generic — and pick a name

- **Generic runner** (`llm.generate`, `ffmpeg.concat`): behavior is the
  same regardless of which workflow/model — knowledge stays in config/data.
- **Bound runner** (`comfy.klein`, `comfy.fl2v`, `comfy.ltx_director`,
  `comfy.qwen_edit_chain`): it legitimately knows one workflow family's
  shape. Name it for that family. This is allowed and honest.

If several bound runners share boilerplate (endpoint resolution, upload,
queue, download, caching), factor that into a **helper module that is NOT
a runner** — e.g. `comfyExecutor` (`src/dag/runners/comfyExecutor.ts`).
The helper is plain code the runners call; it is not registered and no
bundle can target it.

---

## 3a. Authoring a ComfyUI runner — reuse `comfyExecutor`

Don't re-implement Comfy plumbing. `executeComfyWorkflow(opts)` already
does: endpoint resolution, per-endpoint model aliases, image upload (with
transient retry), queue/wait, output download, CAS get/put,
skip-if-exists, manifest-driven required-input enforcement, and a generic
`pruneAndRedirect` graph op. Your runner only does the workflow-specific
part: resolve named inputs + (if the graph has optional branches) supply a
`pruneAbsent` callback. Pattern (see `comfyKlein.ts` / `comfyTti.ts` /
`comfyFl2v.ts`):

```ts
export function createComfyFooRunner(opts?: { clientFactory?: ... }): Runner {
  const clientFactory = opts?.clientFactory ?? defaultComfyClientFactory;
  const describe = (): RunnerDescription => ({ id: 'comfy.foo', /* … */ });
  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as Record<string, unknown>;
    // 1. resolve your named inputs from ctx.inputs / cfg
    const imageInputs = { base_image: /* abs path */ };
    return executeComfyWorkflow({
      ctx, tool: 'comfy.foo',
      workflowPath: cfg['workflowPath'] as string,
      manifestPath: cfg['manifestPath'] as string,
      endpoint: cfg['endpoint'] as string,
      outputPath: cfg['outputPath'] as string,
      prompt, imageInputs, scalars,
      pruneAbsent: /* optional: delete absent optional branches + rewire */,
      clientFactory,
    });
  }
  return { describe, run };
}
export const comfyFooRunner = createComfyFooRunner();
```

The manifest (`*.manifest.json`) maps named inputs → workflow nodes
(`parameterMappings`) and declares which are `required` (`inputRequirements`)
— see the bundle-authoring skill. Prune topology that depends on specific
node ids lives in YOUR runner (it's bound), like `KLEIN_REFERENCE_BRANCHES`
in `comfyKlein.ts`.

## 3b. Authoring a non-Comfy runner (LLM / ffmpeg / a new API)

Implement `run` directly, reusing these building blocks:
- `resolveEndpointUrl(name)` (`endpointResolver.ts`) — named endpoints via
  `ENDPOINT_<name>` env; return `ok:false` with an actionable message when unset.
- `retryTransient(fn, { signal, log, label })` — retry 502/504/ECONNRESET etc.
- `openGenerationCache()` + `InputsHashKey` (`cas/`) — content-addressed
  cache: build a key over EVERY input that affects the output, `get` before
  work, `put` after. (Skip via `DHEE_DISABLE_CAS=1`.)
- Honor `ctx.signal?.aborted` before and between expensive steps.
- Write the artifact to `resolve(ctx.projectDir, cfg.outputPath)`; confirm
  it exists; return `{ ok: true, outputPath, metadata }`.

See `llmGenerate.ts` (full non-Comfy example) and `comfyLtxDirector.ts`
(bound video runner).

---

## 4. Register it

Add a `{ manifest, runner }` entry to `BUILTIN_MANIFESTS` in
`src/dag/runners/index.ts`:

```ts
{
  manifest: {
    tool: 'comfy.foo', version: '0.1.0', engineCompat: '>=0.1.0',
    credentials: [],            // e.g. ['RUNWAY_API_KEY'] for a paid API
    displayName: 'Comfy Foo', description: '…',
  },
  runner: comfyFooRunner,
}
```

The registry rejects duplicate tool ids and, at walk start,
`validateDependencies` checks every bundle's `dependencies.runners`:
the tool must be registered, its version must satisfy the declared range,
and all `credentials` env vars must be set — else the bundle fails BEFORE
any work runs. (Runners shipped OUTSIDE the core are discovered at startup
from `~/.kshana/runners/` via a `runner.json` manifest.)

---

## 5. Test it (TDD — see the test-loop skill)

Use the `createXRunner({ clientFactory })` DI seam so tests inject a stub
client and never hit a real GPU/API. Tests must exercise REAL behavior —
call `runner.run(ctx)` with a temp `bundleDir`/`projectDir` and assert the
result + the queued payload + the written output. For Comfy runners, copy
the REAL workflow + manifest into the temp bundle so node-id-specific logic
(mappings, prune) is exercised against the shipped graph (see
`tests/dag/runners/comfyKlein.test.ts`).

```bash
npx vitest run tests/dag/runners/comfyFoo.test.ts
npx tsc --noEmit -p tsconfig.json
```

---

## 6. Wire it into a bundle

A node targets your runner by `runner.tool`; the bundle lists it in
`dependencies.runners` with a semver range. Then test-run a stage:

```bash
pnpm dhee run-to <project> <node_using_comfy.foo>
# endpoint override when .env points self.local at a dead tunnel:
COMFY_MODE=local ENDPOINT_self_local=http://<host>:8188 pnpm dhee run-to <project> <node>
```

See the **bundle-authoring** skill for the node/manifest side.

## Gotchas
- **Return, don't throw** — the walker reads `RunnerResult`. Throwing turns
  a clean failure into an opaque crash + lost retry semantics.
- **`ctx.bundleDir` is required** for path-resolving runners — fail loudly if absent.
- **CAS key completeness** — if an input affects the output but isn't in the
  key, you'll serve stale cache. Include workflow file bytes, prompt, image
  bytes, dimensions, seed-affecting config.
- **Honor `ctx.signal`** — long renders must cancel cleanly.
- **Bound name = bound code; generic name = generic code.** Don't grow a
  generic runner into a workflow-specific one — split + rename.

## Publishing your runner

To share a runner beyond this repo, publish it as an npm package named
**`dhee-runner-<name>`** (or `@scope/dhee-runner-<name>`), with
`keywords: ["dhee-runner"]` and a `dhee.runners` entry point exporting
`{ manifest, runner }` pairs — dhee-core discovers it ESLint-plugin-style
and registers the runners by their `tool` id. Full convention:
`docs/ecosystem-package-conventions.md`.

## Reference files
- Contract: `src/dag/schema.ts` (Runner / RunnerContext / RunnerResult / RunnerDescription)
- Registry: `src/dag/runners/registry.ts`, registration in `src/dag/runners/index.ts`
- Shared Comfy core: `src/dag/runners/comfyExecutor.ts`
- Bound-runner examples: `comfyKlein.ts`, `comfyFl2v.ts`, `comfyLtxDirector.ts`
- Generic-runner example: `llmGenerate.ts`
- Endpoint / retry helpers: `endpointResolver.ts`, `transientRetry.ts`
- The other side of the wire: the **bundle-authoring** skill
