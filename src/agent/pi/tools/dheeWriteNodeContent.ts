/**
 * dhee_write_node_content — override a node's output with
 * user-supplied content. The walker treats the new content as the
 * canonical output going forward; downstream nodes are invalidated
 * so the next dispatch picks up the change.
 *
 *   - Resolves outputPath from the bundle's outputs.pattern (expands
 *     {{item_id}}, {{scene_id}}, {{shot_id}} from the item context).
 *   - Writes bytes to that path.
 *   - Marks the node completed in walkState with generation.tool='user'
 *     so the walker doesn't re-fire the runner.
 *   - Computes transitive downstream nodes from bundle.edges and
 *     invalidates each (clears walkState + deletes their artifact).
 *   - Appends node.completed + node.invalidated events for audit.
 *
 * Why mutate walkState directly instead of going through ProjectionEngine?
 * The rest of the regen path mutates walkState directly today; the
 * event-sourced graph projection is still partial. Following the same
 * pattern keeps "user override" consistent with how "regenerate" works.
 * Once ProjectionEngine fully replaces walkState, this tool moves with it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { openEventLog } from '../../../dag/eventLog/EventLog.js';
import { loadBundle } from '../../../dag/walker.js';
import { parseBundleSource, resolveBundleDir } from '../../../dag/bundleSource.js';
import type { DagBundle, NodeDef } from '../../../dag/schema.js';
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
});

export interface WriteNodeContentDeps {
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function loadBundleFromProject(projectDir: string): DagBundle {
  const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as { bundleSource?: string };
  if (typeof pj.bundleSource !== 'string') {
    throw new Error(`project.json has no bundleSource field.`);
  }
  const src = parseBundleSource(pj.bundleSource);
  const bundleDir = resolveBundleDir(src);
  let manifestPath = bundleDir;
  try {
    if (statSync(bundleDir).isDirectory()) {
      manifestPath = join(bundleDir, 'bundle.json');
    }
  } catch {
    /* fall through */
  }
  return loadBundle(manifestPath);
}

function applyPattern(pattern: string, ctx: Record<string, string>): string {
  return pattern.replace(/\{\{(\w+)\}\}/g, (_, k: string) => ctx[k] ?? `{{${k}}}`);
}

/**
 * Forward-walk the bundle DAG from `startNodeId`, returning every
 * transitively downstream node id (not including the start). Edges
 * come from `node.inputs[].from` (consumer-declared upstream pointer);
 * we invert into an adjacency list `from → to[]` and BFS.
 */
function downstreamNodes(bundle: DagBundle, startNodeId: string): string[] {
  const downstream = new Map<string, Set<string>>();
  for (const n of bundle.nodes as NodeDef[]) {
    for (const inp of (n.inputs ?? []) as Array<{ from?: string }>) {
      if (!inp.from) continue;
      const list = downstream.get(inp.from) ?? new Set<string>();
      list.add(n.id);
      downstream.set(inp.from, list);
    }
  }
  const visited = new Set<string>([startNodeId]);
  const queue = [startNodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of downstream.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  visited.delete(startNodeId);
  return [...visited];
}

interface WalkStateEntry {
  status?: string;
  outputPath?: string;
  completedAt?: string;
  generation?: { tool?: string; toolVersion?: string };
}

interface WalkState {
  nodes?: Record<string, WalkStateEntry | undefined>;
  lastInvalidatedIds?: string[];
}

interface ProjectJson {
  walkState?: WalkState;
  [k: string]: unknown;
}

function readProjectJson(projectDir: string): ProjectJson {
  return JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as ProjectJson;
}

function writeProjectJson(projectDir: string, pj: ProjectJson): void {
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(pj, null, 2), 'utf8');
}

export function makeWriteNodeContentTool(deps: WriteNodeContentDeps = {}) {
  const loadBundleFn = deps.loadBundleForProject ?? loadBundleFromProject;

  return defineTool({
    name: 'dhee_write_node_content',
    label: 'Write node content',
    description:
      "Override a node's output with user content. Resolves the canonical path from the bundle's outputs.pattern, writes the bytes, marks the node as user-completed in walkState, and invalidates downstream nodes so the next dhee_run_bundle cascades. Use this to rewrite a generated prompt, hand-edit a JSON plan, or swap a generated image for one the user supplied (via attachments → kind='localFile').",
    parameters: Params,
    async execute(_id, params) {
      // 1. Sanity checks.
      if (!existsSync(params.projectDir)) {
        return textResult(`projectDir not found: ${params.projectDir}`, true);
      }
      const pjPath = join(params.projectDir, 'project.json');
      if (!existsSync(pjPath)) {
        return textResult(`project.json missing at ${pjPath}.`, true);
      }

      // 2. Load bundle + resolve node.
      let bundle: DagBundle;
      try {
        bundle = loadBundleFn(params.projectDir);
      } catch (e) {
        return textResult(
          `Failed to load bundle for project: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      const nodeDef = (bundle.nodes as NodeDef[]).find((n) => n.id === params.nodeId);
      if (!nodeDef) {
        const known = (bundle.nodes as NodeDef[]).map((n) => n.id).slice(0, 12).join(', ');
        return textResult(
          `Unknown nodeId '${params.nodeId}'. Bundle '${bundle.id}' has nodes: ${known}${(bundle.nodes as NodeDef[]).length > 12 ? '…' : ''}.`,
          true,
        );
      }

      // 3. Resolve outputPath via pattern expansion. The walker uses
      //    the same set of placeholder names — item_id / scene_id /
      //    shot_id all map to inst.itemId. chunk_id is omitted (the
      //    user shouldn't be overriding sub-chunks).
      const itemId = params.itemId ?? '';
      const outputPath = applyPattern(nodeDef.outputs.pattern, {
        item_id: itemId,
        scene_id: itemId,
        shot_id: itemId,
        chunk_id: '',
      });

      // 4. Path safety: must resolve inside projectDir.
      if (isAbsolute(outputPath)) {
        return textResult(
          `Bundle node '${params.nodeId}' outputs.pattern is absolute ('${outputPath}') — refusing.`,
          true,
        );
      }
      const targetAbs = resolve(params.projectDir, outputPath);
      const projectAbs = resolve(params.projectDir);
      const rel = relative(projectAbs, targetAbs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return textResult(
          `Node '${params.nodeId}' outputPath resolves to '${targetAbs}' which is outside the project dir — refusing as path traversal.`,
          true,
        );
      }

      // 5. Materialize + write.
      let bytes: Buffer;
      try {
        bytes = resolveWritePayload(params.payload as WritePayload);
      } catch (e) {
        return textResult(
          `Failed to resolve payload: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      mkdirSync(dirname(targetAbs), { recursive: true });
      writeFileSync(targetAbs, bytes);

      // 6. Update walkState: mark this node completed (tool=user) and
      //    invalidate every transitive downstream.
      const pj = readProjectJson(params.projectDir);
      const walkState: WalkState = pj.walkState ?? {};
      walkState.nodes = walkState.nodes ?? {};
      walkState.lastInvalidatedIds = walkState.lastInvalidatedIds ?? [];
      const key = itemId ? `${params.nodeId}:${itemId}` : params.nodeId;
      walkState.nodes[key] = {
        status: 'completed',
        outputPath,
        completedAt: new Date().toISOString(),
        generation: { tool: 'user', toolVersion: '0.1.0' },
      };

      const downstream = downstreamNodes(bundle, params.nodeId);
      const invalidatedKeys: string[] = [];
      for (const downId of downstream) {
        // Clear EVERY key matching `<downId>` or `<downId>:*` since
        // collection nodes may have many items registered.
        for (const k of Object.keys(walkState.nodes)) {
          const bare = k.includes(':') ? k.split(':')[0] : k;
          if (bare !== downId) continue;
          const entry = walkState.nodes[k];
          const op = entry?.outputPath;
          if (typeof op === 'string' && op.length > 0) {
            const abs = resolve(params.projectDir, op);
            try {
              if (existsSync(abs)) unlinkSync(abs);
            } catch {
              /* best-effort */
            }
          }
          delete walkState.nodes[k];
          invalidatedKeys.push(k);
        }
        if (!walkState.lastInvalidatedIds.includes(downId)) {
          walkState.lastInvalidatedIds.push(downId);
        }
      }
      pj.walkState = walkState;
      writeProjectJson(params.projectDir, pj);

      // 7. Append events for audit.
      const log = openEventLog(params.projectDir);
      log.append({
        kind: 'node.completed',
        actor: 'agent',
        branchId: 'main',
        payload: {
          nodeId: params.nodeId,
          ...(itemId ? { itemId } : {}),
          versionId: `user-${Date.now()}`,
          outputPath,
          generation: {
            tool: 'user',
            toolVersion: '0.1.0',
            cached: false,
          },
          ...(params.reason ? { metadata: { reason: params.reason } } : {}),
        },
      });
      for (const downId of downstream) {
        log.append({
          kind: 'node.invalidated',
          actor: 'agent',
          branchId: 'main',
          payload: {
            nodeId: downId,
            reason: `cascade from user override of ${params.nodeId}`,
          },
        });
      }

      return textResult(
        `Wrote ${bytes.length} bytes to ${outputPath} for ${key}. Invalidated ${invalidatedKeys.length} downstream entr${invalidatedKeys.length === 1 ? 'y' : 'ies'} (${downstream.join(', ') || 'none'}). Call dhee_run_bundle to cascade.`,
      );
    },
  });
}

export const dheeWriteNodeContentTool = makeWriteNodeContentTool();
