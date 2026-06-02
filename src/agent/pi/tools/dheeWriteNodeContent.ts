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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { openEventLog } from '../../../dag/eventLog/EventLog.js';
import { preserveAsVersion } from '../../../dag/preserveAsVersion.js';
import { loadBundle } from '../../../dag/walker.js';
import { parseBundleSource, resolveBundleDir } from '../../../dag/bundleSource.js';
import { cascadeInvalidationKeys, type CascadeTarget } from '../../../dag/cascadeInvalidationKeys.js';
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
 * Per-instance cascade keys for a target (`nodeId` or `nodeId:itemId`).
 * Reads the project's event log and uses cascadeInvalidationKeys —
 * the same helper invalidateNodes uses. Returns the cascade with the
 * TARGET itself excluded (we don't clear the entry we're about to
 * write). When the event log is unreadable or empty, falls back to a
 * structural BFS over bundle edges — but at INSTANCE granularity
 * (downstream items with the same itemId). This matches the runtime
 * dep semantics for typical per-shot bundles where shot_image:N
 * consumes shot_image_prompt:N.
 *
 * Pre-fix (the bug this fixes): cascade was a bare-node-id BFS that
 * cleared ALL items of every downstream node — editing shot 3 wiped
 * shots 1..N of shot_image, scene_clip, and final_video. With
 * cascadeInvalidationKeys, only the items actually consuming the
 * edited target get cleared.
 */
function cascadeDownstreamKeys(
  projectDir: string,
  bundle: DagBundle,
  target: CascadeTarget,
): CascadeTarget[] {
  let cascade: CascadeTarget[] = [];
  try {
    const log = openEventLog(projectDir);
    cascade = cascadeInvalidationKeys([...log.read()], target);
  } catch {
    cascade = [{ nodeId: target.nodeId, ...(target.itemId !== undefined ? { itemId: target.itemId } : {}) }];
  }
  // Empty cascade (or cascade with only the target) means the event log
  // has no per-instance dep info for this target. Fall back to the
  // structural BFS so a project that's never recorded events still
  // cascades correctly. Match itemId where possible: if the target
  // carries an itemId, propagate it to downstream items of collection
  // nodes (typical per-shot pattern). For singleton-to-collection or
  // collection-to-singleton edges, we just use the bare nodeId.
  const cascadeHasNonTarget = cascade.some(
    (k) => !(k.nodeId === target.nodeId && k.itemId === target.itemId),
  );
  if (!cascadeHasNonTarget) {
    cascade = structuralCascade(bundle, target);
  }
  // Exclude the target itself — we just (or are about to) write it.
  return cascade.filter(
    (k) => !(k.nodeId === target.nodeId && k.itemId === target.itemId),
  );
}

/**
 * Structural fallback when the event log can't tell us per-instance
 * deps. BFS over `node.inputs[].from`; for each downstream collection
 * node we propagate the target's itemId (the typical shot pattern).
 * For non-collection downstream nodes the itemId is dropped.
 */
function structuralCascade(bundle: DagBundle, target: CascadeTarget): CascadeTarget[] {
  const downstreamByNodeId = new Map<string, Set<string>>();
  const kindByNodeId = new Map<string, string>();
  for (const n of bundle.nodes as NodeDef[]) {
    kindByNodeId.set(n.id, n.kind);
    for (const inp of (n.inputs ?? []) as Array<{ from?: string }>) {
      if (!inp.from) continue;
      const list = downstreamByNodeId.get(inp.from) ?? new Set<string>();
      list.add(n.id);
      downstreamByNodeId.set(inp.from, list);
    }
  }
  const out: CascadeTarget[] = [];
  const visitedNodeIds = new Set<string>([target.nodeId]);
  const queue: string[] = [target.nodeId];
  out.push({ nodeId: target.nodeId, ...(target.itemId !== undefined ? { itemId: target.itemId } : {}) });
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of downstreamByNodeId.get(cur) ?? []) {
      if (visitedNodeIds.has(next)) continue;
      visitedNodeIds.add(next);
      queue.push(next);
      // Collection downstream + we have an itemId → assume per-instance
      // dep (shot pattern). Else bare.
      if (kindByNodeId.get(next) === 'collection' && target.itemId !== undefined) {
        out.push({ nodeId: next, itemId: target.itemId });
      } else {
        out.push({ nodeId: next });
      }
    }
  }
  return out;
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
      // Open the event log up front so preserve calls can emit
      // version.added events for each rename.
      const log = openEventLog(params.projectDir);

      mkdirSync(dirname(targetAbs), { recursive: true });
      // Non-destructive overwrite: rename existing canonical file to a
      // versioned sibling first so the user can roll back / compare.
      const targetPreserved = preserveAsVersion(targetAbs);
      if (targetPreserved) {
        const relPreserved = relative(resolve(params.projectDir), targetPreserved);
        log.append({
          kind: 'version.added',
          actor: 'agent',
          branchId: 'main',
          payload: {
            nodeId: params.nodeId,
            ...(itemId ? { itemId } : {}),
            versionId: `preserved-${Date.now()}-${params.nodeId}${itemId ? '-' + itemId : ''}`,
            outputPath: relPreserved,
            source: 'runner',
            reason: 'preserved on overwrite by dhee_write_node_content',
          },
        });
      }
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

      // Per-instance cascade. `cascadeDownstreamKeys` reads the event
      // log + uses cascadeInvalidationKeys, so an edit on
      // shot_image_prompt:scene_1_shot_3 invalidates ONLY
      // shot_image:scene_1_shot_3 and its true downstream — not
      // sibling shots. The target itself is excluded (we just wrote it).
      const target: CascadeTarget = {
        nodeId: params.nodeId,
        ...(itemId ? { itemId } : {}),
      };
      const downstreamCascade = cascadeDownstreamKeys(params.projectDir, bundle, target);
      const invalidatedKeys: string[] = [];
      const downstreamNodeIdsSeen = new Set<string>();
      for (const dk of downstreamCascade) {
        const dKey = dk.itemId !== undefined ? `${dk.nodeId}:${dk.itemId}` : dk.nodeId;
        downstreamNodeIdsSeen.add(dk.nodeId);
        const entry = walkState.nodes[dKey];
        if (!entry) continue; // never completed; nothing to preserve/clear
        const op = entry.outputPath;
        if (typeof op === 'string' && op.length > 0) {
          const abs = resolve(params.projectDir, op);
          try {
            const preserved = preserveAsVersion(abs);
            if (preserved) {
              const relPreserved = relative(resolve(params.projectDir), preserved);
              log.append({
                kind: 'version.added',
                actor: 'agent',
                branchId: 'main',
                payload: {
                  nodeId: dk.nodeId,
                  ...(dk.itemId ? { itemId: dk.itemId } : {}),
                  versionId: `preserved-${Date.now()}-${dKey}`,
                  outputPath: relPreserved,
                  source: 'runner',
                  reason: `preserved by cascade from ${params.nodeId} override`,
                },
              });
            }
          } catch {
            /* best-effort */
          }
        }
        delete walkState.nodes[dKey];
        invalidatedKeys.push(dKey);
      }
      // lastInvalidatedIds is keyed by bare nodeId — track every distinct
      // downstream node we touched (matches the old behavior).
      for (const downId of downstreamNodeIdsSeen) {
        if (!walkState.lastInvalidatedIds.includes(downId)) {
          walkState.lastInvalidatedIds.push(downId);
        }
      }
      pj.walkState = walkState;
      writeProjectJson(params.projectDir, pj);

      // 7. Append events for audit.
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
      for (const dk of downstreamCascade) {
        log.append({
          kind: 'node.invalidated',
          actor: 'agent',
          branchId: 'main',
          payload: {
            nodeId: dk.nodeId,
            ...(dk.itemId ? { itemId: dk.itemId } : {}),
            reason: `cascade from user override of ${params.nodeId}`,
          },
        });
      }

      return textResult(
        `Wrote ${bytes.length} bytes to ${outputPath} for ${key}. Invalidated ${invalidatedKeys.length} downstream entr${invalidatedKeys.length === 1 ? 'y' : 'ies'} (${[...downstreamNodeIdsSeen].join(', ') || 'none'}). Call dhee_run_bundle to cascade.`,
      );
    },
  });
}

export const dheeWriteNodeContentTool = makeWriteNodeContentTool();
