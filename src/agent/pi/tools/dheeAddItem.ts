/**
 * dhee_add_item — add ONE entry to an agentEditable plan node (a new
 * character / setting / shot) in the bottom-up authoring flow (#147).
 *
 * This is the ONLY way to change WHICH items exist in a plan. To change
 * an existing item's generated output bytes (e.g. swap in an uploaded
 * image), use dhee_write_node_content WITH an itemId. To describe a
 * change to an LLM output, use dhee_critique_node.
 *
 * Thin wrapper over applyPlanItemEdit (src/dag/planItems.ts): validates
 * the item against the node's itemSchema, enforces id uniqueness, and
 * writes with item-aware invalidation (siblings + their files survive).
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { applyPlanItemEdit } from '../../../dag/planItems.js';
import type { DagBundle } from '../../../dag/schema.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  nodeId: Type.String({
    description:
      "The agentEditable plan node to append to, e.g. 'characters_plan', 'settings_plan'. Must be marked agentEditable in the bundle.",
  }),
  item: Type.Unknown({
    description:
      "The new item object, e.g. { id: 'fisherman', name: 'The Fisherman', description: '…' }. Must satisfy the node's itemSchema and carry a unique id.",
  }),
  itemKey: Type.Optional(
    Type.String({
      description:
        "Override which array in the plan to append to (e.g. 'shots' vs 'scenes'). Defaults to the node's fan-out key — omit unless the plan has multiple arrays.",
    }),
  ),
});

export interface AddItemDeps {
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeAddItemTool(deps: AddItemDeps = {}) {
  return defineTool({
    name: 'dhee_add_item',
    label: 'Add plan item',
    description:
      "Add ONE new item (a character, setting, shot, …) to an agentEditable plan node — the way to build a project bottom-up, item by item. This is the ONLY tool that changes WHICH items exist. Validates against the node's itemSchema and appends; only the new item materializes on the next run (existing items + their files are untouched). After adding, call dhee_start_run (optionally stopAt the item's render stage) to generate just the new one. To REPLACE an existing item's output bytes (e.g. an uploaded image), use dhee_write_node_content with itemId instead; to DESCRIBE a change to an LLM output, use dhee_critique_node.",
    parameters: Params,
    async execute(_id, params) {
      const r = applyPlanItemEdit({
        projectDir: params.projectDir,
        nodeId: params.nodeId,
        op: 'add',
        item: params.item,
        ...(params.itemKey !== undefined ? { itemKey: params.itemKey } : {}),
        ...(deps.loadBundleForProject ? { loadBundleForProject: deps.loadBundleForProject } : {}),
      });
      if (!r.ok) return textResult(r.error, true);
      return textResult(r.message);
    },
  });
}

export const dheeAddItemTool = makeAddItemTool();
