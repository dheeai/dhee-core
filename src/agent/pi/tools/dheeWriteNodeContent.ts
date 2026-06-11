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
      "Replace ONE existing node/item's output with EXACT bytes you already have — an uploaded/attached image (kind='localFile'), a JSON object you've fully composed, a file the user hand-wrote. For a per-item node (character_image, shot_image, …) you MUST pass itemId — it names which item's bytes to replace (omitting it is an ERROR, not a whole-collection write). Use this to swap in an uploaded image for an EXISTING item (e.g. character_image + itemId='concept_car'). This is the 'replace the bytes' tool — NOT for: (a) changing WHICH items exist (add a character, drop a shot) → use dhee_add_item / dhee_remove_item (membership changes through this tool on an agentEditable plan node are refused); (b) DESCRIBING a change to an LLM output ('make it wider', 'darker mood') → use dhee_critique_node. Marks the node user-completed (pinned against upstream cascades) and cascades downstream.",
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
