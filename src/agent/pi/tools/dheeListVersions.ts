/**
 * dhee_list_versions — return the candidate tray for a node (and
 * optional itemId). Read-only.
 *
 * Thin wrapper over `ProjectionEngine.listVersions`. This is what
 * lets the agent describe "I have 3 candidates for shot 5; v2 is
 * currently selected; v1 had a hand artifact; v3 has the cleanest
 * silhouette." The agent uses the result to decide whether to
 * `dhee_select_version` or `dhee_regenerate_node`.
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

import { openProjectionEngine } from '../../../dag/eventLog/ProjectionEngine.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({ description: 'Bundle node id to list versions for.' }),
  itemId: Type.Optional(
    Type.String({
      description: "For collection nodes, the specific item (e.g. 'scene_1_shot_3'). Omit for stage nodes.",
    }),
  ),
  branchId: Type.Optional(
    Type.String({ description: 'Branch to project. Defaults to "main".' }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeListVersionsTool() {
  return defineTool({
    name: 'dhee_list_versions',
    label: 'List versions',
    description:
      "Return the candidate tray for a node (or one item of a collection node). Each entry includes versionId, outputPath, the runner/tool that produced it, cost, and whether it's currently selected. Use this before deciding which version to pick or whether to regenerate.",
    parameters: Params,
    async execute(_id, params) {
      const eng = openProjectionEngine(params.projectDir);
      const versions = eng.listVersions(
        params.nodeId,
        params.itemId,
        params.branchId ? { branchId: params.branchId } : {},
      );
      if (versions.length === 0) {
        return textResult(`No versions yet for ${params.nodeId}${params.itemId ? `:${params.itemId}` : ''}.`);
      }
      const lines = versions.map((v) => {
        const sel = v.selected ? '★' : ' ';
        const tool = v.generation?.tool ?? '?';
        const cached = v.generation?.cached ? ' (cached)' : '';
        const cost = typeof v.generation?.costUsd === 'number' ? ` $${v.generation.costUsd.toFixed(4)}` : '';
        return `${sel} ${v.versionId.padEnd(12)} via ${tool}${cached}${cost} → ${v.outputPath}`;
      });
      return textResult(
        `Versions for ${params.nodeId}${params.itemId ? `:${params.itemId}` : ''} (${versions.length} candidate${versions.length === 1 ? '' : 's'}):\n${lines.join('\n')}`,
      );
    },
  });
}

export const dheeListVersionsTool = makeListVersionsTool();
