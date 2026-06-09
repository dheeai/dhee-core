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
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeRegenerateNodeTool(deps: RegenerateNodeDeps = {}) {
  return defineTool({
    name: 'dhee_regenerate_node',
    label: 'Regenerate node',
    description:
      "Invalidate a single node (or a single collection item) and re-run it + everything downstream. Use when the user is unhappy with one specific output. Don't use to re-run the whole project — call dhee_start_run for that.",
    parameters: Params,
    async execute(_id, params, signal) {
      const result = await regenerateNode({
        projectDir: params.projectDir,
        nodeId: params.nodeId,
        ...(params.itemId ? { itemId: params.itemId } : {}),
        ...(signal ? { signal } : {}),
        ...(deps.runProjectViaBundle ? { runProjectViaBundle: deps.runProjectViaBundle } : {}),
      });
      const key = params.itemId ? `${params.nodeId}:${params.itemId}` : params.nodeId;
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
