/**
 * dhee_regenerate_node — invalidate a single node (optionally a
 * single item of a collection node) and re-dispatch the bundle so
 * that node + its downstream re-runs.
 *
 * Two-step operation:
 *   1. Delete the node's walkState entry and mark it in
 *      `lastInvalidatedIds`. We deliberately preserve every OTHER
 *      node so a per-item regen on a collection doesn't blast the
 *      siblings.
 *   2. Dispatch runProjectViaBundle with `runOnly:[nodeId]`. The
 *      walker cascades to all dependents of that node.
 *
 * The tool blocks on the dispatched run, mirroring dhee_run_bundle.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import type {
  RunProjectViaBundleOpts,
  RunProjectViaBundleResult,
} from '../../../server/runners/runProjectViaBundle.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({ description: 'Bundle node id to regenerate.' }),
  itemId: Type.Optional(
    Type.String({
      description:
        "For collection nodes, the specific item to regenerate (e.g. 'scene_1_shot_3'). Omit to regenerate the whole node.",
    }),
  ),
});

export interface RegenerateNodeDeps {
  runProjectViaBundle?: (opts: RunProjectViaBundleOpts) => Promise<RunProjectViaBundleResult>;
}

interface NodeEntry {
  status?: string;
  outputPath?: string;
  itemId?: string;
  error?: string;
}
interface ProjectJson {
  walkState?: {
    nodes?: Record<string, NodeEntry>;
    lastInvalidatedIds?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function defaultRunner(opts: RunProjectViaBundleOpts): Promise<RunProjectViaBundleResult> {
  const mod = await import('../../../server/runners/runProjectViaBundle.js');
  return mod.runProjectViaBundle(opts);
}

export function makeRegenerateNodeTool(deps: RegenerateNodeDeps = {}) {
  const runner = deps.runProjectViaBundle ?? defaultRunner;
  return defineTool({
    name: 'dhee_regenerate_node',
    label: 'Regenerate node',
    description:
      "Invalidate a single node (or a single collection item) and re-run it + everything downstream. Use when the user is unhappy with one specific output. Don't use to re-run the whole project — call dhee_run_bundle for that.",
    parameters: Params,
    async execute(_id, params, signal) {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }

      let project: ProjectJson;
      try {
        project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
      } catch (err) {
        return textResult(`project.json failed to parse: ${(err as Error).message}`, true);
      }

      const key = params.itemId ? `${params.nodeId}:${params.itemId}` : params.nodeId;
      project.walkState ??= { nodes: {}, lastInvalidatedIds: [] };
      project.walkState.nodes ??= {};
      project.walkState.lastInvalidatedIds ??= [];
      delete project.walkState.nodes[key];
      if (!project.walkState.lastInvalidatedIds.includes(params.nodeId)) {
        project.walkState.lastInvalidatedIds.push(params.nodeId);
      }
      writeFileSync(projectJsonPath, JSON.stringify(project, null, 2), 'utf8');

      const opts: RunProjectViaBundleOpts = {
        projectDir: params.projectDir,
        runOnly: [params.nodeId],
        ...(signal ? { signal } : {}),
      };
      let result: RunProjectViaBundleResult;
      try {
        result = await runner(opts);
      } catch (err) {
        return textResult(
          `Invalidation written, but runProjectViaBundle threw: ${(err as Error).message}`,
          true,
        );
      }
      if (!result.ok) {
        return textResult(
          `Invalidation written, but bundle re-run failed: ${result.error ?? '(no error message)'}`,
          true,
        );
      }
      return textResult(`Regenerated '${key}'. Downstream nodes cascade-rerun via walker.`);
    },
  });
}

export const dheeRegenerateNodeTool = makeRegenerateNodeTool();
