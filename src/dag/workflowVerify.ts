/**
 * workflowVerify — minimal "what does this workflow ask for + what's
 * actually available?" reporter. Two pure-ish helpers:
 *
 *   1. extractModelRefs(workflow) — parse a ComfyUI workflow JSON;
 *      return every model reference (class, nodeId, inputField,
 *      current filename). Pure.
 *
 *   2. checkWorkflow({workflow, endpoint, fetchObjectInfo}) — query
 *      Comfy's /object_info, return raw facts: the workflow's refs,
 *      the available-models-per-class map, and a flat `missing_refs`
 *      list of refs whose current_value is NOT in the available list
 *      for its (class, field).
 *
 * No verdicts. No fuzzy ranking. No manifest equivalences. The agent
 * looks at the data and decides what to do — pick a substitute, ask
 * the user, or tell them to install something. Cross-class swaps
 * (UNETLoader ↔ UnetLoaderGGUF) are also the agent's call; the
 * available_by_class map exposes every class the user's Comfy has,
 * so the agent can see GGUF / NF4 / quantized variants directly.
 *
 * Tool surface enforces blast radius elsewhere (apply tool is
 * restricted to string substitution + class_type swaps). This module
 * is read-only.
 */

/** Minimal ComfyUI workflow JSON shape we care about. */
export interface ComfyWorkflowNode {
  class_type: string;
  inputs?: Record<string, unknown>;
}
export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

/** Shape of `<endpoint>/object_info`. */
export type ObjectInfo = Record<string, unknown>;

export interface WorkflowModelRef {
  /** class_type of the node (e.g. UNETLoader, LoraLoaderModelOnly). */
  nodeType: string;
  /** node id within the workflow. */
  nodeId: string;
  /** input field name (e.g. unet_name, lora_name, vae_name). */
  inputField: string;
  /** current filename declared by the bundle's workflow. */
  current_value: string;
}

export interface MissingNodeClass {
  /** node id within the workflow. */
  nodeId: string;
  /**
   * The class_type that is NOT installed on the target Comfy. If a
   * class_swap was applied for this node, this is the swapped-to class
   * (so "the thing you remapped to also isn't there" is visible).
   */
  class_type: string;
}

export interface CheckResult {
  ok: boolean;
  endpoint: string;
  /** Every model reference parsed out of the workflow. */
  workflow_refs: WorkflowModelRef[];
  /**
   * Subset of `workflow_refs` whose current_value is NOT in the
   * available list for its (class, field). The agent sees these as
   * the work to be done.
   */
  missing_refs: WorkflowModelRef[];
  /**
   * Workflow nodes whose class_type is NOT among the target Comfy's
   * installed node classes (the keys of /object_info). A missing
   * custom-node pack (e.g. an LTX Director node) surfaces here —
   * distinct from a missing model file (missing_refs). ComfyUI exposes
   * no "list installed packs" endpoint, so node-class presence in
   * /object_info IS the detection signal; the human-readable pack/
   * install hint comes from a bundle's requirements manifest (later).
   */
  missing_node_classes: MissingNodeClass[];
  /**
   * Available model names per `<class>.<field>` on the target Comfy.
   * Includes EVERY class the user has (UNETLoader, UnetLoaderGGUF,
   * CLIPLoader, etc.) so the agent can pick cross-class candidates
   * itself without a separately-declared equivalence map.
   */
  available_by_class: Record<string, string[]>;
  /** Set when /object_info fetch failed. */
  error?: string;
}

export interface CheckOpts {
  workflow: ComfyWorkflow;
  endpoint: string;
  fetchObjectInfo: (endpointUrl: string) => Promise<ObjectInfo>;
  /**
   * Pre-applied name aliases for this endpoint (canonical→local).
   * Refs whose current_value has an alias to a name that IS
   * available on Comfy are filtered OUT of missing_refs.
   */
  endpointAliases?: Record<string, string>;
  /**
   * Pre-resolved per-node class_type swaps for THIS workflow
   * (nodeId → swapped class), from workflowAliases.class_swaps[wfKey].
   * A node with a swap is checked against the swapped class, so a swap
   * to an installed class clears it from missing_node_classes.
   */
  classSwaps?: Record<string, string>;
}

const MODEL_EXTS = [
  '.safetensors',
  '.ckpt',
  '.pt',
  '.pth',
  '.bin',
  '.gguf',
  '.onnx',
  '.sft',
];

function looksLikeModelFilename(s: string): boolean {
  const lower = s.toLowerCase();
  return MODEL_EXTS.some((ext) => lower.endsWith(ext));
}

export function extractModelRefs(workflow: ComfyWorkflow): WorkflowModelRef[] {
  const out: WorkflowModelRef[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [field, value] of Object.entries(inputs)) {
      if (!field.endsWith('_name')) continue;
      if (typeof value !== 'string') continue;
      if (!looksLikeModelFilename(value)) continue;
      out.push({
        nodeType: node.class_type,
        nodeId,
        inputField: field,
        current_value: value,
      });
    }
  }
  return out;
}

/**
 * Every (nodeId, class_type) in the workflow. Pure — no availability
 * judgment. Nodes without a usable string class_type are skipped.
 */
export function extractNodeClasses(
  workflow: ComfyWorkflow,
): { nodeId: string; class_type: string }[] {
  const out: { nodeId: string; class_type: string }[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object') continue;
    if (typeof node.class_type !== 'string' || node.class_type.length === 0) continue;
    out.push({ nodeId, class_type: node.class_type });
  }
  return out;
}

/**
 * Which of the workflow's node classes are NOT installed on the
 * target Comfy. `installedClasses` is the key set of /object_info.
 * Pure. classSwaps (nodeId → swapped class, already scoped to this
 * workflow) is applied first, so a swap to an installed class clears
 * the gap; a swap to a still-missing class is reported as the
 * swapped-to class.
 */
export function findMissingNodeClasses(
  workflow: ComfyWorkflow,
  installedClasses: Set<string>,
  classSwaps: Record<string, string> = {},
): MissingNodeClass[] {
  const out: MissingNodeClass[] = [];
  for (const { nodeId, class_type } of extractNodeClasses(workflow)) {
    const effective = classSwaps[nodeId] ?? class_type;
    if (!installedClasses.has(effective)) {
      out.push({ nodeId, class_type: effective });
    }
  }
  return out;
}

/**
 * Walk /object_info and flatten to `<class>.<field>` → [names]. Only
 * fields with array-of-strings values survive; nodes whose input
 * options are dropdowns of non-string values (e.g. integers) are
 * skipped.
 */
function flattenAvailable(info: ObjectInfo): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [className, cls] of Object.entries(info)) {
    if (!cls || typeof cls !== 'object') continue;
    const input = (cls as Record<string, unknown>)['input'];
    if (!input || typeof input !== 'object') continue;
    const required = (input as Record<string, unknown>)['required'];
    if (!required || typeof required !== 'object') continue;
    for (const [fieldName, fieldSpec] of Object.entries(required)) {
      if (!Array.isArray(fieldSpec) || fieldSpec.length === 0) continue;
      const list = fieldSpec[0];
      if (!Array.isArray(list)) continue;
      const names = list.filter((x): x is string => typeof x === 'string');
      if (names.length === 0) continue;
      out[`${className}.${fieldName}`] = names;
    }
  }
  return out;
}

export async function checkWorkflow(opts: CheckOpts): Promise<CheckResult> {
  const { workflow, endpoint, fetchObjectInfo, endpointAliases = {} } = opts;

  let info: ObjectInfo;
  try {
    info = await fetchObjectInfo(endpoint);
  } catch (err) {
    return {
      ok: false,
      endpoint,
      workflow_refs: extractModelRefs(workflow),
      missing_refs: [],
      missing_node_classes: [],
      available_by_class: {},
      error: (err as Error).message,
    };
  }

  const available_by_class = flattenAvailable(info);
  const workflow_refs = extractModelRefs(workflow);
  const missing_refs: WorkflowModelRef[] = [];

  for (const ref of workflow_refs) {
    const effective = endpointAliases[ref.current_value] ?? ref.current_value;
    const key = `${ref.nodeType}.${ref.inputField}`;
    const list = available_by_class[key];
    if (list && list.includes(effective)) continue;
    missing_refs.push(ref);
  }

  // /object_info's top-level keys ARE the installed node classes; a
  // class_type that isn't a key is a missing custom node. Same
  // round-trip, so node detection costs nothing extra.
  const installedClasses = new Set(Object.keys(info));
  const missing_node_classes = findMissingNodeClasses(
    workflow,
    installedClasses,
    opts.classSwaps ?? {},
  );

  return {
    ok: missing_refs.length === 0 && missing_node_classes.length === 0,
    endpoint,
    workflow_refs,
    missing_refs,
    missing_node_classes,
    available_by_class,
  };
}
