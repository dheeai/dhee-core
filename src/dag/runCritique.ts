/**
 * runCritique — apply a critique to an LLM-generated bundle node.
 *
 * Semantics:
 *   1. Validate the target node uses an LLM runner (`llm.*`). Non-LLM
 *      runners are deterministic given their inputs and have nowhere
 *      to put critique — the user must critique upstream instead.
 *   2. Stamp the critique into `project.json` under a new
 *      `pendingCritiques` map, keyed by `nodeId` for singletons and
 *      `nodeId:itemId` for collection items. Survives walkState
 *      invalidation (it's a sibling field, not nested under `nodes`).
 *   3. Invalidate the target via the existing `invalidateNodes` helper
 *      so the walker's next pass re-fires it.
 *   4. Dispatch `runProjectViaBundle({ runOnly: [bareNodeId] })`. The
 *      walker cascades to downstream nodes automatically.
 *
 * The llm.generate runner reads `pendingCritiques` before its LLM call;
 * if a critique exists for the current (node, item), it prepends a
 * system message conveying the critique, forces re-render past the
 * cache, and clears the entry on success.
 *
 * No mutation of the bundle. No direct LLM call here. Composable with
 * `computeCascadeImpact` for the preview / confirmation step.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DagBundle } from './schema.js';
import { invalidateNodes } from './projectRegen.js';

export interface RunCritiqueOpts {
  projectDir: string;
  bundle: DagBundle;
  nodeId: string;
  /** Optional item id for collection nodes. */
  itemId?: string;
  critique: string;
  /**
   * When true: stamp pendingCritique + invalidate target, but DO NOT
   * dispatch the bundle. Use when batching many critiques back-to-back
   * (e.g. 22 broken shots at once) — calling code does ONE
   * `runProjectViaBundle` at the end to process every stamped critique
   * in a single walker pass. Default false preserves prior behavior
   * (dispatch immediately, await cascade completion).
   */
  applyOnly?: boolean;
  /** Injectable for tests; defaults to the lazy-imported real runner. */
  runProjectViaBundle?: (opts: {
    projectDir: string;
    runOnly?: string[];
    signal?: AbortSignal;
  }) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface RunCritiqueResult {
  ok: boolean;
  error?: string;
  /** Whatever the dispatched runner returned. */
  runResult?: unknown;
}

async function defaultDispatcher(opts: {
  projectDir: string;
  runOnly?: string[];
  signal?: AbortSignal;
}): Promise<unknown> {
  const mod = await import('../server/runners/runProjectViaBundle.js');
  return mod.runProjectViaBundle(opts as never);
}

export async function runCritique(opts: RunCritiqueOpts): Promise<RunCritiqueResult> {
  const { projectDir, bundle, nodeId, itemId, critique } = opts;

  // 1. Validate node + runner.
  const node = bundle.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: `unknown node: ${nodeId}` };
  if (!node.runner.tool.startsWith('llm.')) {
    return {
      ok: false,
      error: `only llm.* runners can be critiqued — node '${nodeId}' uses '${node.runner.tool}'. ` +
        `Walk upstream and critique the nearest llm.* node instead.`,
    };
  }

  // 2. Read project.json.
  const projectPath = join(projectDir, 'project.json');
  if (!existsSync(projectPath)) {
    return { ok: false, error: `project.json not found at ${projectPath}` };
  }
  let project: Record<string, unknown>;
  try {
    project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `project.json failed to parse: ${(err as Error).message}` };
  }

  // 3. Stamp the critique into pendingCritiques[key].
  const key = itemId ? `${nodeId}:${itemId}` : nodeId;
  const pending = (project['pendingCritiques'] as Record<string, string> | undefined) ?? {};
  pending[key] = critique;
  project['pendingCritiques'] = pending;
  writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf8');

  // 4. Invalidate the target — walker re-fires it on next dispatch.
  const inv = await invalidateNodes({ projectDir, nodeIds: [key] });
  // If the node had no walkState entry yet (never ran), invalidate
  // returns it in `notFound`. That's fine — the critique is still
  // applied for the next regen.
  if (inv.error) return { ok: false, error: inv.error };

  // 5a. applyOnly: skip dispatch. Caller batches many critiques and
  //     runs the bundle once at the end.
  if (opts.applyOnly) return { ok: true };

  // 5b. Dispatch bundle with runOnly on the bare node id. Walker handles
  //     item-level + downstream cascade.
  const dispatch = opts.runProjectViaBundle ?? defaultDispatcher;
  try {
    const runResult = await dispatch({
      projectDir,
      runOnly: [nodeId],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { ok: true, runResult };
  } catch (err) {
    return { ok: false, error: `bundle dispatch failed: ${(err as Error).message}` };
  }
}
