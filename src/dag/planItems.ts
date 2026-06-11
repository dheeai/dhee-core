/**
 * applyPlanItemEdit — add or remove ONE item in an agentEditable plan
 * node (#147 bottom-up building). This is the sanctioned membership-edit
 * path that backs the dhee_add_item / dhee_remove_item tools.
 *
 * It is NOT a tool itself — the agent only ever sees dhee_add_item /
 * dhee_remove_item, which are thin wrappers over this.
 *
 * Flow:
 *   - load bundle, find node, assert node.agentEditable
 *   - resolve which array to edit (the fan-out itemKey)
 *   - add: AJV-validate the item against node.itemSchema, enforce id
 *     uniqueness, append
 *   - remove: drop the entry whose deriveItemId matches
 *   - write the updated plan via writeNodeContent({ viaPlanItemEdit:true,
 *     confirm:true }) — so item-aware invalidation + the user pin
 *     (generation.tool='user') come for free, and the membership
 *     hard-block (which refuses raw membership edits) is bypassed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as ajvNs from 'ajv';
import { writeNodeContent } from './writeNodeContent.js';
import { deriveItemId } from './itemId.js';
import { loadBundle } from './walker.js';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
import type { DagBundle, NodeDef } from './schema.js';

// ajv's CJS default-export shape (mirrors runners/llmGenerate.ts).
const Ajv = ((ajvNs as unknown as { default?: unknown }).default ?? ajvNs) as unknown as new (
  opts?: Record<string, unknown>,
) => { compile: (s: Record<string, unknown>) => (data: unknown) => boolean };

export interface ApplyPlanItemEditInput {
  projectDir: string;
  nodeId: string;
  op: 'add' | 'remove';
  /** The item object to append (op='add'). */
  item?: unknown;
  /** The itemId to remove (op='remove'). */
  itemId?: string;
  /** Override which plan array to edit; defaults to the fan-out itemKey. */
  itemKey?: string;
  /** Test/host seam — defaults to reading project.json's bundleSource. */
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

export type ApplyPlanItemEditResult =
  | { ok: false; error: string }
  | { ok: true; itemId: string; itemKey: string; itemCount: number; message: string };

function loadBundleFromProject(projectDir: string): DagBundle {
  const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as {
    bundleSource?: string;
  };
  if (typeof pj.bundleSource !== 'string') throw new Error('project.json has no bundleSource field.');
  const bundleDir = resolveBundleDir(parseBundleSource(pj.bundleSource));
  let manifestPath = bundleDir;
  try {
    if (statSync(bundleDir).isDirectory()) manifestPath = join(bundleDir, 'bundle.json');
  } catch {
    /* fall through */
  }
  return loadBundle(manifestPath);
}

/**
 * Resolve which array key in the plan JSON this node's items live under:
 * an explicit override → the node's own itemKey → the itemKey of the
 * first collection that fans out over this node → 'items' as a last
 * resort.
 */
function resolveItemKey(bundle: DagBundle, node: NodeDef, override?: string): string {
  if (override) return override;
  if (node.itemKey) return node.itemKey;
  const fanOut = (bundle.nodes).find((n) => n.itemSource === node.id && n.itemKey);
  return fanOut?.itemKey ?? 'items';
}

export function applyPlanItemEdit(input: ApplyPlanItemEditInput): ApplyPlanItemEditResult {
  if (!existsSync(input.projectDir)) {
    return { ok: false, error: `projectDir not found: ${input.projectDir}` };
  }
  let bundle: DagBundle;
  try {
    bundle = (input.loadBundleForProject ?? loadBundleFromProject)(input.projectDir);
  } catch (e) {
    return { ok: false, error: `Failed to load bundle: ${e instanceof Error ? e.message : String(e)}` };
  }
  const node = (bundle.nodes).find((n) => n.id === input.nodeId);
  if (!node) return { ok: false, error: `Unknown nodeId '${input.nodeId}'.` };
  if (!node.agentEditable) {
    return {
      ok: false,
      error: `Node '${input.nodeId}' is not agent-editable — only plan nodes marked agentEditable accept dhee_add_item / dhee_remove_item.`,
    };
  }

  const itemKey = resolveItemKey(bundle, node, input.itemKey);

  // Read the current plan (seed an empty array if the node hasn't run).
  const outputAbs = join(input.projectDir, node.outputs.pattern);
  let plan: Record<string, unknown> = { [itemKey]: [] };
  if (existsSync(outputAbs)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(outputAbs, 'utf8'));
      if (parsed && typeof parsed === 'object') plan = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: `Existing plan at ${node.outputs.pattern} is not valid JSON — fix or regenerate it first.` };
    }
  }
  if (!Array.isArray(plan[itemKey])) plan[itemKey] = [];
  const items = plan[itemKey] as unknown[];

  let affectedId: string;
  if (input.op === 'add') {
    if (input.item == null || typeof input.item !== 'object') {
      return { ok: false, error: `add requires an 'item' object.` };
    }
    // Validate against the node's per-item schema when declared — but
    // only for the DEFAULT (fan-out) array. itemSchema describes one
    // item of that array; an explicit itemKey override (e.g. editing
    // scenes_plan's `scenes` instead of its fan-out `shots`) targets a
    // differently-shaped array, so skip strict validation there.
    if (node.itemSchema && input.itemKey === undefined) {
      try {
        const validate = new Ajv({ allErrors: true }).compile(node.itemSchema);
        if (!validate(input.item)) {
          return { ok: false, error: `Item does not satisfy '${input.nodeId}' itemSchema.` };
        }
      } catch (e) {
        return { ok: false, error: `itemSchema invalid: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    affectedId = deriveItemId(input.item as never);
    if (!affectedId) {
      return { ok: false, error: `Item has no derivable id (needs an 'id' or 'name' field).` };
    }
    if (items.some((it) => deriveItemId(it as never) === affectedId)) {
      return { ok: false, error: `An item with id '${affectedId}' already exists in '${input.nodeId}'.` };
    }
    items.push(input.item);
  } else {
    if (!input.itemId) return { ok: false, error: `remove requires an 'itemId'.` };
    affectedId = input.itemId;
    const idx = items.findIndex((it) => deriveItemId(it as never) === affectedId);
    if (idx === -1) {
      return { ok: false, error: `No item with id '${affectedId}' in '${input.nodeId}'.` };
    }
    items.splice(idx, 1);
  }

  const r = writeNodeContent({
    projectDir: input.projectDir,
    nodeId: input.nodeId,
    content: Buffer.from(JSON.stringify(plan, null, 2), 'utf8'),
    viaPlanItemEdit: true,
    confirm: true, // explicit user action via the item tool
    reason: `${input.op} item '${affectedId}' via dhee_${input.op === 'add' ? 'add' : 'remove'}_item`,
    ...(input.loadBundleForProject ? { loadBundleForProject: input.loadBundleForProject } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.status === 'preview') {
    // Shouldn't happen (confirm:true), but surface it rather than lie.
    return { ok: false, error: r.preview };
  }

  const verb = input.op === 'add' ? 'Added' : 'Removed';
  const invalidated = r.invalidatedKeys.length;
  return {
    ok: true,
    itemId: affectedId,
    itemKey,
    itemCount: items.length,
    message:
      `${verb} '${affectedId}' ${input.op === 'add' ? 'to' : 'from'} '${input.nodeId}' (${items.length} item${items.length === 1 ? '' : 's'} now). ` +
      (invalidated > 0
        ? `${invalidated} downstream entr${invalidated === 1 ? 'y' : 'ies'} invalidated — run to regenerate.`
        : `Nothing downstream to invalidate — run to materialize.`),
  };
}
