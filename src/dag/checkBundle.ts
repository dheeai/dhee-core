/**
 * checkBundle — aggregate "does this endpoint have what this bundle
 * needs?" across every ComfyUI workflow a bundle ships. Wraps
 * checkWorkflow (models + custom-node detection), applies any saved
 * per-endpoint aliases (name_aliases + per-workflow class_swaps), and
 * rolls the per-workflow facts into one bundle-level verdict.
 *
 * Effects are confined to: reading the bundle's workflows/ dir and ONE
 * memoized network read of /object_info (shared across all workflows).
 * No verdicts about HOW to fix — the agent / UI decides from each
 * workflow's missing_refs / missing_node_classes / available_by_class.
 *
 * This is the engine behind the desktop "Bundle Configurator" (used by
 * first-run setup, community-bundle install, and bring-your-own
 * workflow) and a future run-start pre-flight.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkWorkflow,
  type ComfyWorkflow,
  type ObjectInfo,
  type WorkflowModelRef,
  type MissingNodeClass,
} from './workflowVerify.js';
import { readAliases, defaultAliasesDir } from './workflowAliases.js';

export interface BundleWorkflowFit {
  /**
   * Path relative to bundleDir, e.g. "workflows/ltx_director_local.json".
   * Also the key used to look up class_swaps for this workflow.
   */
  workflowKey: string;
  ok: boolean;
  missing_refs: WorkflowModelRef[];
  missing_node_classes: MissingNodeClass[];
  available_by_class: Record<string, string[]>;
  /** Set when the workflow JSON could not be read/parsed, or /object_info failed. */
  error?: string;
}

export type BundleFitStatus = 'ready' | 'incomplete' | 'unreachable';

export interface BundleFit {
  bundleDir: string;
  endpoint: string;
  workflows: BundleWorkflowFit[];
  /** Total missing model refs across all workflows. */
  modelsMissing: number;
  /** Total missing custom-node classes across all workflows. */
  nodesMissing: number;
  /**
   * ready       — no model or node gaps on any workflow.
   * incomplete  — at least one gap or unreadable workflow (the UI/agent
   *               decides fixable-vs-blocked from the per-workflow
   *               detail + available_by_class).
   * unreachable — /object_info could not be read (endpoint down / wrong URL).
   */
  status: BundleFitStatus;
}

export interface CheckBundleOpts {
  bundleDir: string;
  endpoint: string;
  fetchObjectInfo: (endpointUrl: string) => Promise<ObjectInfo>;
  /**
   * Where per-endpoint aliases live. Defaults to
   * $DHEE_WORKFLOW_ALIASES_DIR or ~/.dhee/workflow-aliases — the same
   * store the agent's dhee_apply_workflow_aliases tool writes to.
   */
  aliasesDir?: string;
}


/**
 * A bundle's ComfyUI workflow files: workflows/*.json, excluding the
 * sidecar *.manifest.json descriptors. Returns paths relative to
 * bundleDir. Empty when the bundle ships no workflows (e.g. a
 * text-only bundle).
 */
export function listBundleWorkflows(bundleDir: string): string[] {
  const dir = join(bundleDir, 'workflows');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.manifest.json'))
    .sort()
    .map((f) => join('workflows', f));
}

export async function checkBundle(opts: CheckBundleOpts): Promise<BundleFit> {
  const { bundleDir, endpoint, fetchObjectInfo } = opts;
  const aliasesDir = opts.aliasesDir ?? defaultAliasesDir();
  const aliases = readAliases(aliasesDir, endpoint);
  const nameAliases = aliases.name_aliases ?? {};
  const classSwaps = aliases.class_swaps ?? {};

  // One /object_info read, shared across every workflow. If it fails,
  // the rejected promise is cached so each workflow surfaces the same
  // error and we classify the bundle as unreachable.
  let cached: Promise<ObjectInfo> | null = null;
  let objectInfoError: string | null = null;
  const memoFetch = (url: string): Promise<ObjectInfo> =>
    (cached ??= fetchObjectInfo(url).catch((err: unknown) => {
      objectInfoError = err instanceof Error ? err.message : String(err);
      throw err;
    }));

  const keys = listBundleWorkflows(bundleDir);
  const workflows: BundleWorkflowFit[] = [];

  for (const workflowKey of keys) {
    const abs = join(bundleDir, workflowKey);
    let workflow: ComfyWorkflow;
    try {
      workflow = JSON.parse(readFileSync(abs, 'utf8')) as ComfyWorkflow;
    } catch (err) {
      workflows.push({
        workflowKey,
        ok: false,
        missing_refs: [],
        missing_node_classes: [],
        available_by_class: {},
        error: `workflow JSON unreadable: ${(err as Error).message}`,
      });
      continue;
    }
    const result = await checkWorkflow({
      workflow,
      endpoint,
      fetchObjectInfo: memoFetch,
      endpointAliases: nameAliases,
      classSwaps: classSwaps[workflowKey] ?? {},
    });
    workflows.push({
      workflowKey,
      ok: result.ok,
      missing_refs: result.missing_refs,
      missing_node_classes: result.missing_node_classes,
      available_by_class: result.available_by_class,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  const modelsMissing = workflows.reduce((n, w) => n + w.missing_refs.length, 0);
  const nodesMissing = workflows.reduce((n, w) => n + w.missing_node_classes.length, 0);

  let status: BundleFitStatus;
  if (objectInfoError !== null) {
    status = 'unreachable';
  } else if (modelsMissing > 0 || nodesMissing > 0 || workflows.some((w) => w.error)) {
    status = 'incomplete';
  } else {
    status = 'ready';
  }

  return { bundleDir, endpoint, workflows, modelsMissing, nodesMissing, status };
}
