/**
 * dhee_write_node_content — override a node's output with
 * user-supplied content. Thin agent-facing wrapper around the shared
 * `writeNodeContent` core (src/dag/writeNodeContent.ts): it resolves
 * the WritePayload → bytes, then delegates. The desktop Inspector's
 * inline Edit calls the same core over IPC, so both surfaces share
 * the per-instance cascade + preserve-as-version semantics.
 *
 * See writeNodeContent.ts for the behaviour contract (outputPath
 * resolution, path-safety, blast-radius gate, walkState + events).
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import {
  writeNodeContent,
  type WriteNodeContentInput,
} from '../../../dag/writeNodeContent.js';
import type { DagBundle } from '../../../dag/schema.js';
import { resolveWritePayload, WritePayloadSchema, type WritePayload } from './writePayload.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  nodeId: Type.String({
    description:
      "Bundle node id to override (e.g. 'plot', 'shot_image_prompt', 'shot_image'). The node must be declared in the active bundle.",
  }),
  itemId: Type.Optional(
    Type.String({
      description:
        "For collection nodes, the specific item (e.g. 'scene_1_shot_3'). Omit for non-collection nodes.",
    }),
  ),
  payload: WritePayloadSchema,
  reason: Type.Optional(
    Type.String({
      description: 'Short note explaining WHY the override was applied. Recorded on the event log.',
    }),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description:
        'Required to proceed on a HIGH-BLAST-RADIUS write (editing a fan-out source node like scenes_plan, which re-renders every shot). Call FIRST without confirm to get the blast-radius preview, then confirm=true to apply. Surgical per-item edits (e.g. shot_image_prompt with an itemId) write immediately and ignore this.',
    }),
  ),
});

export interface WriteNodeContentDeps {
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeWriteNodeContentTool(deps: WriteNodeContentDeps = {}) {
  return defineTool({
    name: 'dhee_write_node_content',
    label: 'Write node content',
    description:
      "Replace a node's output with EXACT bytes you already have — a file the user hand-wrote, an uploaded/attached image (kind='localFile'), a JSON object you've fully composed. This is for supplying finished content, NOT for describing a change: to ADJUST what an LLM produced ('make it wider', 'darker mood'), use dhee_critique_node instead — it's surgical and previews impact. Writes to the canonical path, marks the node user-completed, and cascades downstream. For a per-shot change, target that shot's item node (e.g. 'shot_image_prompt' + itemId). Editing a fan-out source like 'scenes_plan' re-renders every shot and requires confirm=true (you'll get a blast-radius preview first).",
    parameters: Params,
    async execute(_id, params) {
      // Resolve the payload → bytes, then hand off to the shared core.
      let bytes: Buffer;
      try {
        bytes = resolveWritePayload(params.payload as WritePayload);
      } catch (e) {
        return textResult(`Failed to resolve payload: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      const input: WriteNodeContentInput = {
        projectDir: params.projectDir,
        nodeId: params.nodeId,
        content: bytes,
        ...(params.itemId !== undefined ? { itemId: params.itemId } : {}),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        ...(params.confirm !== undefined ? { confirm: params.confirm } : {}),
        ...(deps.loadBundleForProject ? { loadBundleForProject: deps.loadBundleForProject } : {}),
      };
      const r = writeNodeContent(input);

      if (!r.ok) return textResult(r.error, true);
      if (r.status === 'preview') return textResult(r.preview);
      return textResult(r.message);
    },
  });
}

export const dheeWriteNodeContentTool = makeWriteNodeContentTool();
