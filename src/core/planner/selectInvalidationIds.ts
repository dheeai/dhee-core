/**
 * Pure selector for the unified `dhee_invalidate` operation.
 *
 * Three selection modes — `node`, `type`, `stage` — converge on a flat
 * list of node ids that the invalidate op then marks pending (or
 * removes, for per-item nodes inside stage mode). This function is
 * pure: read-only over `ExecutorState`, no I/O, no mutation.
 *
 * Why three modes:
 *   - `node`  — surgical "redo this one shot's prompt" intent
 *   - `type`  — "redo every shot prompt across the project"
 *                (the type-level gap previously only filled by reset)
 *   - `stage` — "redo this stage and everything downstream by type"
 *                (the existing dhee_reset behavior — preserved)
 *
 * The output of this function feeds two consumers:
 *   1. The invalidate op itself, which decides whether to mark each
 *      id pending or remove it (per-item nodes under stage mode → remove).
 *   2. `project.executorState.lastInvalidatedIds` — persisted so a
 *      later `dhee_run_to scope='last_invalidated'` runs only this
 *      whitelist instead of every pending node in the graph.
 */
import type { ExecutorState } from "../project/projectTypes.js";
import { resolveNodeId } from "../project/projectTypes.js";
import { STAGE_ALIASES, TEMPLATE_DEPS } from "./stages.js";

export interface InvalidationSelection {
  /** Single fully-qualified node id ("shot_image:scene_1_shot_2") or
   *  friendly alias ("scene_1_shot_2.image"). Resolves via resolveNodeId. */
  node?: string;
  /** Type id ("shot_image_prompt") — selects the type-level collection
   *  node plus every per-item node of that type. */
  type?: string;
  /** Stage alias ("shot_image_prompt", "shot_video", …) — selects the
   *  start type's full type cone via TEMPLATE_DEPS, then expands to
   *  every node of every covered type. */
  stage?: string;
}

/**
 * Walk the typed-dependency graph forward from `startType` and return
 * every type that's reachable. Mirrors `computeResetTypes` in
 * resetProjectStage.ts (kept as a private helper there). Local copy
 * keeps this module dependency-free for trivial unit testability.
 */
function typeConeFrom(startType: string): string[] {
  const dependents: Record<string, string[]> = {};
  for (const [type, deps] of Object.entries(TEMPLATE_DEPS)) {
    for (const dep of deps) {
      (dependents[dep] ??= []).push(type);
    }
  }
  const seen = new Set<string>([startType]);
  const queue = [startType];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const dep of dependents[cur] ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen];
}

/**
 * Return every node id (type-level collection + per-item) whose
 * `typeId` is in the given set.
 */
function idsByType(state: ExecutorState, types: Set<string>): string[] {
  const out: string[] = [];
  for (const [id, node] of Object.entries(state.nodes)) {
    if (types.has(node.typeId)) out.push(id);
  }
  return out;
}

export function selectInvalidationIds(
  state: ExecutorState,
  opts: InvalidationSelection,
): string[] {
  const provided = [opts.node, opts.type, opts.stage].filter(
    (v) => v !== undefined,
  );
  if (provided.length !== 1) {
    throw new Error(
      "selectInvalidationIds: exactly one of `node`, `type`, or `stage` must be provided.",
    );
  }

  if (opts.node !== undefined) {
    const id = resolveNodeId(state, opts.node);
    return id ? [id] : [];
  }

  if (opts.type !== undefined) {
    return idsByType(state, new Set([opts.type]));
  }

  // stage mode
  const startTypes = STAGE_ALIASES[opts.stage!];
  if (!startTypes) {
    throw new Error(
      `selectInvalidationIds: unknown stage '${opts.stage}'. Valid stages: ${Object.keys(STAGE_ALIASES).join(", ")}`,
    );
  }
  const cone = new Set(startTypes.flatMap(typeConeFrom));
  return idsByType(state, cone);
}
