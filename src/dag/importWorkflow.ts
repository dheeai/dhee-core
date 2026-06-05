/**
 * importWorkflow — support "bring your own ComfyUI workflow". Two
 * checks a user-supplied graph must pass to slot into a Dhee bundle:
 *
 *   1. validateApiWorkflow — it must be API-format JSON (the flat
 *      {nodeId: {class_type, inputs}} map that /prompt accepts), NOT
 *      the UI-format graph ComfyUI's normal "Save" produces. This is
 *      the single most common BYO failure; we detect it so the UI can
 *      tell the user to enable Dev mode → Save (API Format).
 *
 *   2. suggestParameterMappings — which node/field receives each
 *      pipeline input (prompt, seed, width, height, filename_prefix).
 *      Heuristic auto-suggestions the user confirms; the result has the
 *      same shape as a workflow *.manifest.json's parameterMappings.
 *
 * Model + custom-node fit is handled by checkWorkflow/checkBundle — the
 * same Configurator the rest of the feature uses.
 */

import type { ComfyWorkflow } from './workflowVerify.js';

export type ApiWorkflowValidation =
  | { ok: true }
  | { ok: false; reason: 'ui_format' | 'invalid' };

/**
 * Distinguish API-format (flat map of nodes, each with class_type)
 * from UI-format (top-level `nodes` array + `links`/`last_node_id`).
 */
export function validateApiWorkflow(json: unknown): ApiWorkflowValidation {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, reason: 'invalid' };
  }
  const obj = json as Record<string, unknown>;

  // UI-format tell-tales: a `nodes` array plus links / last_node_id.
  if (Array.isArray(obj['nodes']) && ('links' in obj || 'last_node_id' in obj)) {
    return { ok: false, reason: 'ui_format' };
  }

  // API-format: at least one value is an object carrying a string class_type.
  const values = Object.values(obj);
  const looksApi = values.some(
    (v) =>
      v != null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>)['class_type'] === 'string',
  );
  return looksApi ? { ok: true } : { ok: false, reason: 'invalid' };
}

/** Same shape as a workflow manifest's parameterMappings entry. */
export interface ParameterMapping {
  /** Pipeline input id (prompt, seed, width, height, filename_prefix). */
  input: string;
  /** Workflow node id the value is written to. */
  nodeId: string;
  /** Input field on that node. */
  field: string;
}

function hasInput(node: { inputs?: Record<string, unknown> }, field: string): boolean {
  return !!node.inputs && Object.prototype.hasOwnProperty.call(node.inputs, field);
}

/**
 * Heuristic input→node/field suggestions for a user's API workflow.
 * First match wins per input; the user confirms/overrides in the UI.
 * Only inputs we can place are returned.
 */
export function suggestParameterMappings(workflow: ComfyWorkflow): ParameterMapping[] {
  const out: ParameterMapping[] = [];
  const entries = Object.entries(workflow);

  // prompt → first text-encode node's `text` (positive prompt, by convention the first).
  const promptNode = entries.find(
    ([, n]) => /CLIPTextEncode/i.test(n.class_type) && hasInput(n, 'text') && typeof n.inputs!['text'] === 'string',
  );
  if (promptNode) out.push({ input: 'prompt', nodeId: promptNode[0], field: 'text' });

  // seed → first node exposing seed / noise_seed.
  for (const field of ['seed', 'noise_seed']) {
    const seedNode = entries.find(([, n]) => hasInput(n, field));
    if (seedNode) {
      out.push({ input: 'seed', nodeId: seedNode[0], field });
      break;
    }
  }

  // width/height → first node exposing both.
  const dimNode = entries.find(([, n]) => hasInput(n, 'width') && hasInput(n, 'height'));
  if (dimNode) {
    out.push({ input: 'width', nodeId: dimNode[0], field: 'width' });
    out.push({ input: 'height', nodeId: dimNode[0], field: 'height' });
  }

  // filename_prefix → first save node.
  const saveNode = entries.find(([, n]) => hasInput(n, 'filename_prefix'));
  if (saveNode) out.push({ input: 'filename_prefix', nodeId: saveNode[0], field: 'filename_prefix' });

  return out;
}
