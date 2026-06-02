/**
 * dhee_select_version — emit a version.selected event for a node
 * instance. This is the taste-gate pick: downstream walks resolve
 * inputs from the selected version.
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

import { openProjectionEngine } from '../../../dag/eventLog/ProjectionEngine.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({ description: 'Bundle node id.' }),
  versionId: Type.String({ description: 'Version id to make selected (from dhee_list_versions).' }),
  itemId: Type.Optional(
    Type.String({ description: 'For collection nodes, the specific item id.' }),
  ),
  branchId: Type.Optional(
    Type.String({ description: 'Branch to record the selection on. Defaults to "main".' }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeSelectVersionTool() {
  return defineTool({
    name: 'dhee_select_version',
    label: 'Select version',
    description:
      'Mark a specific version as the selected one for a node. Downstream walks will resolve inputs from this version. Non-destructive — other versions remain in the tray.',
    parameters: Params,
    async execute(_id, params) {
      const eng = openProjectionEngine(params.projectDir);
      const tray = eng.listVersions(
        params.nodeId,
        params.itemId,
        params.branchId ? { branchId: params.branchId } : {},
      );
      if (!tray.some((v) => v.versionId === params.versionId)) {
        return textResult(
          `No such version '${params.versionId}' for ${params.nodeId}${params.itemId ? `:${params.itemId}` : ''}. Available: ${tray.map((v) => v.versionId).join(', ') || '(none)'}.`,
          true,
        );
      }
      const event = eng.appendAndProject({
        branchId: params.branchId ?? 'main',
        actor: 'agent',
        kind: 'version.selected',
        payload: {
          nodeId: params.nodeId,
          versionId: params.versionId,
          ...(params.itemId ? { itemId: params.itemId } : {}),
        },
      });
      return textResult(
        `Selected version '${params.versionId}' for ${params.nodeId}${params.itemId ? `:${params.itemId}` : ''} on branch '${event.branchId}'. seq=${event.seq}.`,
      );
    },
  });
}

export const dheeSelectVersionTool = makeSelectVersionTool();
