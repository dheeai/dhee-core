/**
 * dhee_regenerate_node — invalidate a single node (optionally a
 * single item of a collection node) and re-dispatch the bundle so
 * that node + its downstream re-runs.
 *
 * Thin wrapper over `src/dag/projectRegen.regenerateNode` — the
 * shared helper that the desktop's IPC bridge also uses. Keeping
 * both consumers on one helper means "regenerate" means the same
 * thing whether driven by the agent or by right-click.
 */

import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import {
  regenerateNode,
  type RunProjectViaBundleFn,
} from '../../../dag/projectRegen.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({ description: 'Bundle node id to regenerate.' }),
  itemId: Type.Optional(
    Type.String({
      description:
        "For collection nodes, the specific item to regenerate (e.g. 'scene_1_shot_3'). Omit to regenerate the whole node.",
    }),
  ),
});

export interface RegenerateNodeDeps {
  runProjectViaBundle?: RunProjectViaBundleFn;
  /**
   * Max regenerations of the SAME (projectDir, nodeId[:itemId]) key the
   * tool will dispatch for the life of this tool instance (one chat
   * session). Once a key hits the cap, further regens are refused
   * WITHOUT a paid runner call. Defaults to {@link DEFAULT_MAX_REGENS_PER_KEY}.
   *
   * This is the guard for the 2026-06-04 credit-burn incident, where the
   * agent looped ~12x regenerating one node, each a paid generation. The
   * walker's reviewLoopMax caps its internal re-walks; this caps the
   * agent driving the tool from the outside.
   */
  maxRegensPerKey?: number;
}

/**
 * A single node regenerated this many times in one session is already
 * pathological — stop before the ~12x real-world blowout. The agent can
 * still pick an existing version, critique differently, or start a fresh
 * run; this only refuses MORE paid regens of the same node.
 */
export const DEFAULT_MAX_REGENS_PER_KEY = 10;

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeRegenerateNodeTool(deps: RegenerateNodeDeps = {}) {
  const cap = deps.maxRegensPerKey ?? DEFAULT_MAX_REGENS_PER_KEY;
  // Per-instance (≈ per chat session) tally of how many times each key
  // has been dispatched. Lives in this closure so a fresh tool gets a
  // fresh budget.
  const regensByKey = new Map<string, number>();

  return defineTool({
    name: 'dhee_regenerate_node',
    label: 'Regenerate node',
    description:
      "Invalidate a single node (or a single collection item) and re-run it + everything downstream. Use when the user is unhappy with one specific output. Don't use to re-run the whole project — call dhee_start_run for that.",
    parameters: Params,
    async execute(_id, params, signal) {
      const key = params.itemId ? `${params.nodeId}:${params.itemId}` : params.nodeId;

      // Budget gate (credit-burn guard): refuse a (cap+1)th regen of the
      // same key BEFORE any paid runner call. Scoped per projectDir so
      // two projects don't share a budget.
      const budgetKey = `${params.projectDir}::${key}`;
      const used = regensByKey.get(budgetKey) ?? 0;
      if (used >= cap) {
        return textResult(
          `Regeneration limit reached for '${key}' — ${cap} regenerations this session. ` +
            `Refusing to spend more credits re-rolling the same node. Instead: pick an existing ` +
            `candidate (dhee_list_versions → dhee_select_version), critique it differently ` +
            `(dhee_critique_node), or start a fresh run if this is intentional.`,
          true,
        );
      }
      regensByKey.set(budgetKey, used + 1);

      const result = await regenerateNode({
        projectDir: params.projectDir,
        nodeId: params.nodeId,
        ...(params.itemId ? { itemId: params.itemId } : {}),
        ...(signal ? { signal } : {}),
        ...(deps.runProjectViaBundle ? { runProjectViaBundle: deps.runProjectViaBundle } : {}),
      });
      if (!result.ok) {
        return textResult(
          `Regenerate of '${key}' failed: ${result.error ?? '(no error)'}`,
          true,
        );
      }
      return textResult(`Regenerated '${key}'. Downstream nodes cascade-rerun via walker.`);
    },
  });
}

export const dheeRegenerateNodeTool = makeRegenerateNodeTool();
