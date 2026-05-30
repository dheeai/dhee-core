/**
 * dhee_fork — create a new branch from a given point.
 *
 * The fork is just a branch.created event tagged with the fork point's
 * eventId. The parent branch is untouched. Subsequent walks on the new
 * branch reuse the parent's prefix via the projection's branch
 * visibility filter (no events are copied).
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

import { openProjectionEngine } from '../../../dag/eventLog/ProjectionEngine.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  branchId: Type.String({ description: 'New branch id (slug). Must be unique within the project.' }),
  label: Type.Optional(Type.String({ description: 'Human-readable label, e.g. "noir grade".' })),
  parentBranchId: Type.Optional(
    Type.String({ description: 'Branch to fork from. Defaults to "main".' }),
  ),
  forkedFromEventId: Type.Optional(
    Type.String({ description: 'Event id to fork at. Defaults to the latest event on the parent branch.' }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeForkTool() {
  return defineTool({
    name: 'dhee_fork',
    label: 'Fork branch',
    description:
      'Create a new branch from a point in history. The parent branch is preserved unchanged; the new branch can diverge by regenerating any node. Cheap — only divergent nodes re-compute (the rest replay from the content-addressed cache).',
    parameters: Params,
    async execute(_id, params) {
      const eng = openProjectionEngine(params.projectDir);
      const parentBranchId = params.parentBranchId ?? 'main';
      const allEvents = [...eng.log().read({ branchId: parentBranchId })];
      const forkedFromEventId =
        params.forkedFromEventId ?? allEvents[allEvents.length - 1]?.id;
      if (!forkedFromEventId) {
        return textResult(
          `Cannot fork: parent branch '${parentBranchId}' has no events yet.`,
          true,
        );
      }
      const tree = eng.computeBranchTree();
      if (tree.branches.some((b) => b.branchId === params.branchId)) {
        return textResult(`Branch '${params.branchId}' already exists.`, true);
      }
      const event = eng.appendAndProject({
        branchId: parentBranchId,
        actor: 'user',
        kind: 'branch.created',
        payload: {
          branchId: params.branchId,
          parentBranchId,
          forkedFromEventId,
          ...(params.label ? { label: params.label } : {}),
        },
      });
      return textResult(
        `Forked '${params.branchId}'${params.label ? ` ("${params.label}")` : ''} from '${parentBranchId}' at event ${forkedFromEventId}. seq=${event.seq}.\n\nNext: run a walk with branchId="${params.branchId}" — the unchanged prefix replays from cache, only divergent nodes compute.`,
      );
    },
  });
}

export const dheeForkTool = makeForkTool();
