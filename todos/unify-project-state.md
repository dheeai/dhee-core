# Unify project state on the dependency graph (strip legacy)

Branch: `refactor/unify-graph-as-source-of-truth`

## Goal

ONE source of truth for project state — `executorState.nodes` in `project.json`. All parallel/legacy systems retired. Files on disk are the canonical artifact content; nodes carry metadata + outputPath references.

## Subsystems retiring

| # | Subsystem | Approx LOC | Why retiring |
|---|---|---|---|
| **A** | Phase state machine (`project.phases`, `currentPhase`, `PlannerStage`) | ~1,400 | Graph deps already enforce order |
| **B** | Approval CRUD (`approvalStatus`, `regenerationCount` on flat objects) | ~600 | DELETED — approval is pi-agent's domain, not dhee-core's |
| **C** | Content registry (`project.content` with `itemFiles`) | ~700 | Already duplicated by `node.outputPath` |
| **D** | Flat file manifest (`project.files[]`) | ~250 | Derivable from `node.outputPath` across nodes |
| **E** | Flat arrays (`project.characters[]`, `project.settings[]`, `project.scenes[]`) | ~500 | Replaced by graph queries |
| **F** | Legacy `core/artifacts/` triplet + `project.artifacts[]` | ~2,800 | `executorState` IS the graph |
| **G** | Legacy `GenericAgent.ts` + `contentContext.ts` (sub-agent dispatch, flat-field context) | ~5,000 | Executor is the only agent now |

**Total deletable: ~9,500–10,500 LOC**

## What gets added

`ExecutionNode.metadata` optional bag:

```ts
metadata?: {
  name?: string;     // user-facing name when distinct from displayName
  summary?: string;  // 1-line summary surfaced in agent-context tools
};
```

**Approvals are out of scope for dhee-core.** Per founder direction (2026-04-28): all approval / regeneration / feedback flows live in pi-agent (the external orchestrator). Do NOT reintroduce approval fields here without explicit go-ahead.

## Persistence cadence — the bug behind today's mess

`expandCollection()` mutates the node map but does NOT call `persistState()`. A kill between expansion and the first per-item completion → desync. Multiple call sites have this gap (lines 1283, 1291, 1297, 1300, 3586, 3668, 3739, 3787, 3944, 3984, 4945 in `ExecutorAgent.ts`).

Fix: a single `mutateAndPersist<T>(fn)` wrapper in `DependencyGraphExecutor` so EVERY mutation persists. 22 sites collapse to 1.

Add a watchdog test: snapshot in-memory `getState()` and persisted JSON after each public mutation method; assert equal.

## PR sequence

| PR | Scope | Net | Risk |
|---|---|---|---|
| PR0 | **Delete legacy-targeting tests up front** so they don't block deletions | -2,000 | Low |
| PR1 | Add `metadata` to `ExecutionNode`. Add `mutateAndPersist` wrapper. Watchdog test. | +200 | Low |
| PR2 | New `projectView.ts` module with graph queries. Migrate readers in `tools.ts`, `contentContext.ts`, `contentCreatorTools.ts` to use it (flat fields still written, just no longer read). | +400/-100 | Medium |
| PR3 | ~~Move approvals onto nodes~~ — **dropped**. Approvals live in pi-agent. Just delete the `update_*_approval` actions, `updateCharacterApproval`/`updateSettingApproval`/`updateSceneApproval` in ProjectManager, and the per-item-instructions block that depends on them. | -600 | Low |
| PR4 | Strip flat arrays + content registry. Stop writing `project.characters/settings/scenes/content/files`. Bump `PROJECT_VERSION` to `'3.0'`. | +200/-2,000 | High |
| PR5 | Strip phase state machine. Delete `WorkflowPhase`, `PHASE_CONFIGS`, `determineNextPhase`, etc. | +50/-1,500 | Medium |
| PR6 | Delete legacy `core/artifacts/` triplet. | +0/-2,800 | Medium |
| PR7 | Strip legacy `GenericAgent.ts` + `contentContext.ts`. | +100/-5,000 | High |
| PR8 | Schema cleanup. Bump `ProjectFile` to minimal shape. | +100/-200 | Low |

## Tests targeting legacy code (delete in PR0)

Identified by Plan agent. Verifying file paths — see in-progress audit.

## Risk callouts (add tests BEFORE deleting)

1. **Reference image resolution** (`src/tasks/video/tools.ts:1300-1570`). Three lookup priorities, no direct unit test. Add fixture test before PR2.
2. ~~Approval flow round-trip~~. Approvals leaving dhee-core entirely; no new tests needed.
3. **Resume from disk after redo**. Add scenario test before PR3.
4. **`expandCollection` persistence gap**. Watchdog test in PR1.
5. **`run-to <stage>` semantics**. Verify `stages.ts:resolveStageToTypeIds` doesn't read `PHASE_CONFIGS`. Add integration test before PR5.
6. **`regenerateArtifactTool` / `editAndRedo`**. `editAndRedo.ts` already reads `executorState.nodes` only — good. Audit `artifactTools.ts` prompts before PR6.
