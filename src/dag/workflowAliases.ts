/**
 * workflowAliases — per-endpoint persistent store of (a) name aliases
 * for model files and (b) per-workflow per-node class_type swaps.
 *
 * Storage:
 *   <aliasesDir>/<endpoint-slug>/aliases.json
 *
 *   {
 *     "name_aliases": {
 *       "<bundle-canonical-name>": "<user-local-name>"
 *     },
 *     "class_swaps": {
 *       "<workflowKey>": { "<nodeId>": "<NewClassName>" }
 *     }
 *   }
 *
 * The agent's `dhee_apply_workflow_aliases` tool writes here.
 * Runners read here at workflow-load time and apply substitutions
 * in-memory before posting to Comfy. Bundle's canonical workflow
 * stays untouched.
 *
 * Safety guardrail: `applyAliases` ONLY swaps:
 *   - inputs.<*_name> string values (name aliases)
 *   - node.class_type (class swaps, scoped to workflowKey + nodeId)
 *
 * It never adds/removes nodes, reorders, edits non-`*_name` inputs,
 * or touches the graph topology. That's the safety contract the
 * agent's tool surface relies on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComfyWorkflow } from './workflowVerify.js';

export interface WorkflowAliases {
  /** Global per-endpoint name→name remappings. */
  name_aliases?: Record<string, string>;
  /** Per-workflow per-node class_type swaps. */
  class_swaps?: Record<string, Record<string, string>>;
}

/**
 * Normalize an endpoint URL to a filesystem-safe directory name.
 * Strips scheme, replaces anything not [a-z0-9] with underscore,
 * collapses repeats, trims edges.
 */
export function endpointSlug(endpoint: string): string {
  return endpoint
    .replace(/^https?:\/\//i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function aliasesPath(aliasesDir: string, endpoint: string): { dir: string; file: string } {
  const dir = join(aliasesDir, endpointSlug(endpoint));
  return { dir, file: join(dir, 'aliases.json') };
}

export function readAliases(aliasesDir: string, endpoint: string): WorkflowAliases {
  const { file } = aliasesPath(aliasesDir, endpoint);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as WorkflowAliases;
  } catch {
    return {};
  }
}

/**
 * Merge-write: never clobbers keys the caller didn't supply. Lets the
 * agent add one alias at a time without wiping prior ones.
 */
export function writeAliases(
  aliasesDir: string,
  endpoint: string,
  patch: WorkflowAliases,
): void {
  const { dir, file } = aliasesPath(aliasesDir, endpoint);
  mkdirSync(dir, { recursive: true });
  const existing = readAliases(aliasesDir, endpoint);

  const merged: WorkflowAliases = {};
  // name_aliases — shallow merge.
  if (existing.name_aliases || patch.name_aliases) {
    merged.name_aliases = { ...(existing.name_aliases ?? {}), ...(patch.name_aliases ?? {}) };
  }
  // class_swaps — two-level merge (per workflow, per node).
  if (existing.class_swaps || patch.class_swaps) {
    const out: Record<string, Record<string, string>> = { ...(existing.class_swaps ?? {}) };
    for (const [wfKey, perNode] of Object.entries(patch.class_swaps ?? {})) {
      out[wfKey] = { ...(out[wfKey] ?? {}), ...perNode };
    }
    merged.class_swaps = out;
  }

  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
}

export interface ApplyAliasesOpts {
  /** Stable identifier for this workflow (used to look up class_swaps). */
  workflowKey: string;
  aliases: WorkflowAliases;
}

const MODEL_EXTS = ['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.sft'];

function looksLikeModelFilename(s: string): boolean {
  const lower = s.toLowerCase();
  return MODEL_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Apply name aliases + class swaps to a workflow IN A FRESH COPY.
 * Input is never mutated. The substitution is intentionally narrow:
 * only `inputs.<*_name>` string values get renamed, and only nodes
 * matching `(workflowKey, nodeId)` in class_swaps get reclassed.
 */
export function applyAliases(
  workflow: ComfyWorkflow,
  opts: ApplyAliasesOpts,
): ComfyWorkflow {
  const { workflowKey, aliases } = opts;
  const nameMap = aliases.name_aliases ?? {};
  const classSwapsForThisWorkflow = aliases.class_swaps?.[workflowKey] ?? {};

  // Deep clone via JSON to guarantee no mutation of caller's object.
  // Workflows are small JSON; cost is negligible.
  const out: ComfyWorkflow = JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;

  for (const [nodeId, node] of Object.entries(out)) {
    if (!node || typeof node !== 'object') continue;

    // class_type swap, scoped to this workflowKey + this nodeId.
    const newClass = classSwapsForThisWorkflow[nodeId];
    if (newClass) node.class_type = newClass;

    // Name substitutions on *_name string inputs that look like model
    // filenames. Strictly limited to that field-name pattern + string
    // values + extension match — protects against accidentally
    // rewriting integer / boolean / wire-array inputs.
    const inputs = node.inputs;
    if (inputs && typeof inputs === 'object') {
      for (const [field, value] of Object.entries(inputs)) {
        if (!field.endsWith('_name')) continue;
        if (typeof value !== 'string') continue;
        if (!looksLikeModelFilename(value)) continue;
        const newName = nameMap[value];
        if (newName) (inputs as Record<string, unknown>)[field] = newName;
      }
    }
  }

  return out;
}
