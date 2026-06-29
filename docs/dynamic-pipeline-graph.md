# Dynamic Per-Project Pipeline Graph

## Context

Today the dhee-core pipeline is template-driven: `src/templates/narrative.ts` declares `ArtifactTypeDefinition.dependencies`, and at project creation `ArtifactGraph` materialises these into `executorState.nodes` inside `project.json`. The runtime graph IS data-driven — every node, edge, and status lives in `project.json` — but the **shape** of the graph is fixed by the template. To add audio, 4K upscale, ControlNet pose conditioning, or any other step today, a developer must edit `narrative.ts`, add a runner branch in `ExecutorAgent.ts`, update `stages.ts`, and rebuild. There is no per-project deviation.

This plan adds a **curated, splice-capable pipeline catalog** that end users insert into their project's graph from the UI. Catalog v1: audio narration (per-shot), 4K upscale (singleton leaf), ControlNet pose (per-shot splice). Each kind is a first-class node — invalidation, resume-from-disk, status reporting, all the existing executor machinery works on it because it lives in the same `executorState.nodes` map as template nodes.

The architectural lever: stop treating the template as the only source of node definitions. Introduce a **NodeKindRegistry** that template artifact types AND catalog entries register into, and a per-project **pipeline extensions** declaration that's materialised into `executorState.nodes` alongside template nodes.

## Out of scope (deliberate)

- User-authored runners (plugin SDK, custom TS, shell). v1 is a fixed curated catalog. We may revisit after we have one real production user of the extension surface.
- Catalog beyond audio / upscale / ControlNet. Those three exercise each cardinality (per-shot, singleton-leaf, per-shot-splice) and force the design to be honest.
- Cross-template portability. Catalog entries declare which template families they attach to (`narrative` only for v1).

## Design

### 1. `NodeKind` — the unit of extensibility

New file `src/core/pipeline/NodeKind.ts`:

```typescript
export interface NodeKind {
  id: string;                         // typeId used in executorState.nodes
  source: 'template' | 'catalog';
  displayName: string;
  description: string;
  category: ArtifactCategory;
  cardinality: 'singleton' | 'per-scene' | 'per-shot';
  isExpensive: boolean;

  // Where can this kind be inserted? (catalog only — template nodes set this to null)
  attachment: AttachmentRule | null;

  // The runner: ExecutorAgent calls this once dependencies are satisfied.
  runner: (ctx: NodeRunContext) => Promise<NodeRunResult>;

  // UI metadata: icon, configurable knobs
  ui?: { icon?: string; configSchema?: JSONSchema };
}

export interface AttachmentRule {
  mode: 'leaf' | 'splice';
  // Leaf: must depend on these existing typeIds (one of)
  allowedUpstream?: string[];
  // Splice: replaces edge A -> B. Allowed (A, B) pairs:
  allowedSplicePairs?: Array<{ from: string; to: string }>;
}

export interface NodeRunContext {
  node: ExecutionNode;
  resolvedInputs: ResolvedInputs;   // existing type from contentResolver
  projectDir: string;
  project: GenericProjectFile;
  llm: LLMRouter;
  emit: (event: TodoNodeInfo) => void;
}

export interface NodeRunResult {
  outputPath?: string;
  metadata?: Record<string, unknown>;
}
```

### 2. `NodeKindRegistry` — single lookup surface

New file `src/core/pipeline/NodeKindRegistry.ts`. Tiny module with `register(kind)`, `get(typeId)`, `listCatalog()`. Loaded once at process startup from:

- `src/core/pipeline/catalog/index.ts` — barrel that imports each catalog entry (`audioNarration.ts`, `upscale4k.ts`, `controlnetPose.ts`)
- Template artifact types — adapter wraps each `ArtifactTypeDefinition` into a `NodeKind` with `source: 'template'` and a `runner` that delegates back into the existing ExecutorAgent dispatch (initially via a giant switch we already have; long-term we extract each branch into its own `NodeKind.runner`)

Critical: this does NOT rewrite ExecutorAgent in v1. ExecutorAgent's existing `node.typeId === 'X'` switch (50+ branches, see `src/core/planner/ExecutorAgent.ts:2881-3030`) keeps working. We only add **one new fallthrough**: if no built-in branch matched, look up the registry and call `kind.runner(ctx)`. Catalog entries go through the new path; template nodes stay on the old path. Migration to a uniform path is a separate cleanup.

### 3. `project.pipeline.extensions` — the declaration

Add to `project.json`:

```json
"pipeline": {
  "extensions": [
    {
      "instanceId": "ext_audio_001",
      "kindId": "audio_narration",
      "attachment": { "mode": "leaf", "anchorTypeId": "shot_motion_directive" },
      "config": { "voice": "alloy", "model": "tts-1-hd" }
    },
    {
      "instanceId": "ext_pose_001",
      "kindId": "controlnet_pose",
      "attachment": { "mode": "splice", "from": "shot_image_prompt", "to": "shot_image" },
      "config": { "controlNetWeight": 0.8 }
    }
  ]
}
```

`extensions` is the user's source of truth. `executorState.nodes` is the **materialisation** — rebuilt by a new `materializeExtensions(project)` whenever `extensions` changes. For per-shot kinds, materialisation expands one extension into N per-item nodes the same way `addShotImageNodes.ts` already does for template per-shot nodes.

Splice semantics, concretely: inserting `controlnet_pose` between `shot_image_prompt:scene_1_shot_1` and `shot_image:scene_1_shot_1`:
- Add node `controlnet_pose:scene_1_shot_1` with `dependencies: ['shot_image_prompt:scene_1_shot_1']`
- Remove `shot_image_prompt:scene_1_shot_1` from `shot_image:scene_1_shot_1.dependencies`
- Add `controlnet_pose:scene_1_shot_1` to `shot_image:scene_1_shot_1.dependencies`
- Update `dependents` arrays symmetrically
- Call existing `applyInvalidation(['shot_image:scene_1_shot_1'], { cascade: true })` so downstream shot_video etc. re-run

Removal is the exact inverse + reconnect the bypassed edge.

### 4. Wiring into the executor

Three small additions to `src/core/planner/ExecutorAgent.ts`:

- **Materialisation on load**: after `migrateGraphToTemplate(...)`, call `materializeExtensions(project)` to inject extension nodes into `executorState.nodes` if any are missing.
- **Runner fallthrough**: at the bottom of the `typeId === ...` chain (around line 3030), add `else { const kind = registry.get(node.typeId); if (kind?.source === 'catalog') await runCatalogNode(kind, node, ...); }`. The `runCatalogNode` helper resolves inputs, calls `kind.runner`, writes the output, marks the node completed — same shape as existing branches, just delegated.
- **Stage gates**: `stages.ts` `TEMPLATE_DEPS` and `STAGE_ALIASES` learn to include extension typeIds. Done by reading the registry instead of the hardcoded table — small refactor in `src/core/planner/stages.ts`.

### 5. The three v1 catalog entries

| Kind | Cardinality | Attachment | Runner does |
|------|-------------|------------|-------------|
| `audio_narration` | per-shot | leaf, anchor=`shot_motion_directive` | Read shot dialogue/narration text → call OpenAI/ElevenLabs TTS → write `assets/scenes/<scene>/shots/<shot>/narration.mp3` |
| `upscale_4k` | singleton | leaf, anchor=`final` | Read final video path → run RealESRGAN or Topaz CLI → write `assets/final_4k.mp4`, update timeline pointer |
| `controlnet_pose` | per-shot | splice, between `shot_image_prompt` and `shot_image` | Read shot prompt → generate skeleton pose image (DWPose or similar) → write `assets/scenes/.../shots/.../pose_ref.png`. The shot_image node then reads this from `resolvedInputs` and passes it as a Comfy ControlNet input. |

Each catalog entry lives in `src/core/pipeline/catalog/<name>.ts` with the runner code colocated. Prompts for any LLM-using runners live in `src/core/prompts/catalog/<name>.md` per CLAUDE.md ("create the prompt in a different file and import the prompt").

### 6. UI surface (dhee-desktop)

New "Pipeline" tab on the project detail view. Renders the graph as a vertical DAG (react-flow or a simple custom flex layout — defer to whatever's already in use in the desktop repo). Two interactions:

- Hover on an edge → "+" button → opens catalog drawer → user picks a kind → if `splice`, confirm pair; if `leaf`, confirm anchor → preview impact ("This will invalidate 12 nodes: shot_image × 12") → Apply.
- Click on an extension node → "Remove" / "Configure" panel.

Apply/Remove go through new server endpoints `POST /projects/:id/pipeline/extensions` and `DELETE /projects/:id/pipeline/extensions/:instanceId`. These mutate `project.pipeline.extensions`, call `materializeExtensions` + `applyInvalidation`, and return the updated project. The desktop project store re-renders.

### 7. Feature flag

Gate the entire surface behind `project.features.dynamicPipeline` (default `false`). Per CLAUDE.md, register in `docs/feature-flags.md` and seed in `src/server/runners/createProjectInProcess.ts`. Materialisation is a no-op when the flag is off, so existing projects are untouched.

## Files to create

- `src/core/pipeline/NodeKind.ts` — types
- `src/core/pipeline/NodeKindRegistry.ts` — registry
- `src/core/pipeline/materializeExtensions.ts` — extensions → executorState.nodes
- `src/core/pipeline/templateAdapter.ts` — wraps `ArtifactTypeDefinition` as `NodeKind`
- `src/core/pipeline/catalog/index.ts` + `audioNarration.ts` + `upscale4k.ts` + `controlnetPose.ts`
- `src/core/prompts/catalog/*.md` (only for catalog entries that prompt an LLM)
- `src/server/routes/pipelineExtensions.ts` — HTTP endpoints
- (desktop repo) `Pipeline.tsx` view + catalog drawer component

## Files to modify

- `src/core/project/projectTypes.ts` — add `pipeline?: { extensions: PipelineExtension[] }` to `GenericProjectFile`
- `src/core/project/projectSchema.ts` — schema entry for `pipeline`
- `src/core/project/backfillProjectSchema.ts` — backfill `pipeline: { extensions: [] }` for old projects
- `src/core/planner/ExecutorAgent.ts:~3030` — runner fallthrough branch
- `src/core/planner/ExecutorAgent.ts:~around-load` — call `materializeExtensions` after `migrateGraphToTemplate`
- `src/core/planner/stages.ts` — derive `TEMPLATE_DEPS` from registry
- `src/server/runners/createProjectInProcess.ts` — seed `features.dynamicPipeline: false`, `pipeline.extensions: []`
- `src/server/runners/resetProjectStage.ts` — extension typeIds in `COLLECTION_TYPES` (read from registry)
- `docs/feature-flags.md` — register `dynamicPipeline`

## Critical files to study before coding (with line numbers)

- `src/core/planner/ExecutorAgent.ts:2881-3030` — the typeId dispatch we're adding a fallthrough to
- `src/core/planner/applyInvalidation.ts:1-100` — invalidation cascade we'll reuse on insert/remove
- `src/core/planner/addShotImageNodes.ts` — reference pattern for per-shot node materialisation
- `src/core/artifacts/ArtifactGraph.ts:160-200` — current template-only graph build (we're augmenting, not replacing)
- `src/core/planner/migrateGraphToTemplate.ts` — runs at project load, good place to call materialiseExtensions afterward
- `src/core/planner/stages.ts:28-92` — `STAGE_ALIASES` and `TEMPLATE_DEPS` we need to make registry-driven

## Verification

End-to-end manual test on a real project, with `dynamicPipeline: true`:

1. Create a fresh narrative project, run through to `final` → confirm baseline still works (no regression).
2. From the Pipeline tab, insert `upscale_4k` after `final`. Apply. Confirm `final` is NOT invalidated (leaf-only), a new `upscale_4k` node appears in pending, and clicking Run produces `assets/final_4k.mp4`.
3. From the Pipeline tab, splice `controlnet_pose` between `shot_image_prompt` and `shot_image`. Apply. Confirm:
   - All `shot_image:*` nodes flip to pending
   - All downstream `shot_video:*`, `scene_video:*`, `final` cascade-invalidate
   - Re-running produces `pose_ref.png` per shot, and shot_image now uses ControlNet (verify by inspecting the Comfy workflow JSON for one shot)
4. Insert `audio_narration` per-shot. Apply. Confirm narration.mp3 files appear per shot and timeline picks them up.
5. Remove `controlnet_pose`. Confirm `shot_image_prompt → shot_image` edge restored, downstream invalidated.

Unit/integration tests (test-loop, port-then-test pattern from the skill):
- `materializeExtensions.test.ts` — given extension list + template graph, produces expected `executorState.nodes` (splice math, leaf math, per-shot expansion). Real disk via tmp dir, no mocks per the project's testing discipline.
- `pipelineEndpoints.test.ts` — insert/remove via the HTTP endpoint, verify project.json on disk, verify invalidation cascade.
- One catalog runner test per kind (audio: stub TTS at the HTTP boundary; upscale: stub the CLI; controlnet: stub the pose model) — exercises the runner contract, not the external service.

## Phased rollout

1. **Phase A — Infra, no UI, flag off.** Registry, NodeKind, materialiseExtensions, runner fallthrough, feature flag, tests. Catalog has one trivial entry (`upscale_4k` only — easiest, singleton leaf, no per-item expansion). Verifiable end-to-end via project.json hand-edit on a test project. Land as one PR.
2. **Phase B — Per-shot cardinality + ControlNet.** Per-shot expansion, splice attachment, invalidation correctness. Land as one PR.
3. **Phase C — Audio narration.** Adds the second per-shot leaf kind. Validates the catalog can support multiple per-shot kinds simultaneously without interference.
4. **Phase D — Desktop UI.** Pipeline tab, catalog drawer, impact preview. Flag flips on for the user.

Each phase is its own feature branch + PR per the user's standing instructions (`feedback_always_pr_never_direct_merge`).
