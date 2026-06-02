/**
 * writeNodeContent — override a node's output with caller-supplied
 * bytes, mark it user-completed, and cascade-invalidate downstream.
 *
 * This is the shared core behind BOTH surfaces that let a human
 * replace a node's content:
 *   - the `dhee_write_node_content` agent tool (resolves a
 *     WritePayload → bytes, then calls this), and
 *   - the desktop Inspector's inline Edit (writes the edited text
 *     for a node directly over IPC).
 *
 * Keeping the logic here — instead of duplicating the cascade in the
 * renderer — means the Inspector reuses the SAME per-instance cascade
 * (`cascadeInvalidationKeys`) the agent uses. A renderer-side BFS over
 * bundle edges would reintroduce the "edit shot 3 wipes shots 1..N"
 * bug this path was written to avoid.
 *
 * Behaviour (identical to the old tool body):
 *   - Resolves outputPath from the bundle's outputs.pattern (expands
 *     {{item_id}}/{{scene_id}}/{{shot_id}} from the item context).
 *   - Path-safety: refuses absolute patterns + traversal outside the
 *     project dir.
 *   - Blast-radius gate: editing a FAN-OUT SOURCE node without an
 *     itemId (or any edit whose cascade exceeds HIGH_BLAST) returns a
 *     `preview` result unless `confirm: true`. Surgical per-item edits
 *     write immediately.
 *   - Preserves the prior canonical file as a versioned sibling
 *     (emits version.added) before overwriting.
 *   - Marks the node completed in walkState with generation.tool='user'
 *     so the walker won't re-fire the runner.
 *   - Per-instance cascade: preserves + clears each true downstream
 *     instance; emits node.completed (user) + node.invalidated events.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { openEventLog } from './eventLog/EventLog.js';
import { preserveAsVersion } from './preserveAsVersion.js';
import { loadBundle } from './walker.js';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
import { cascadeInvalidationKeys, type CascadeTarget } from './cascadeInvalidationKeys.js';
import type { DagBundle, NodeDef } from './schema.js';

const HIGH_BLAST = 3;

export interface WriteNodeContentInput {
  projectDir: string;
  nodeId: string;
  itemId?: string;
  /** Already-resolved bytes to write (text → Buffer.from(s, 'utf8')). */
  content: Buffer;
  reason?: string;
  /** Required to proceed on a high-blast-radius write. */
  confirm?: boolean;
  /** Test/host seam — defaults to reading project.json's bundleSource. */
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

export type WriteNodeContentResult =
  | { ok: false; error: string }
  | { ok: true; status: 'preview'; preview: string; downstream: CascadeTarget[] }
  | {
      ok: true;
      status: 'written';
      outputPath: string;
      bytesWritten: number;
      invalidatedKeys: string[];
      invalidatedNodeIds: string[];
      message: string;
    };

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
 * Reads the project's event log and uses cascadeInvalidationKeys — the
 * same helper invalidateNodes uses. When the log is unreadable/empty,
 * falls back to a structural BFS over bundle edges at INSTANCE
 * granularity. The TARGET itself is excluded (we don't clear the entry
 * we're about to write).
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
  const cascadeHasNonTarget = cascade.some(
    (k) => !(k.nodeId === target.nodeId && k.itemId === target.itemId),
  );
  if (!cascadeHasNonTarget) {
    cascade = structuralCascade(bundle, target);
  }
  return cascade.filter(
    (k) => !(k.nodeId === target.nodeId && k.itemId === target.itemId),
  );
}

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

export function writeNodeContent(input: WriteNodeContentInput): WriteNodeContentResult {
  const loadBundleFn = input.loadBundleForProject ?? loadBundleFromProject;

  // 1. Sanity checks.
  if (!existsSync(input.projectDir)) {
    return { ok: false, error: `projectDir not found: ${input.projectDir}` };
  }
  const pjPath = join(input.projectDir, 'project.json');
  if (!existsSync(pjPath)) {
    return { ok: false, error: `project.json missing at ${pjPath}.` };
  }

  // 2. Load bundle + resolve node.
  let bundle: DagBundle;
  try {
    bundle = loadBundleFn(input.projectDir);
  } catch (e) {
    return { ok: false, error: `Failed to load bundle for project: ${e instanceof Error ? e.message : String(e)}` };
  }
  const nodeDef = (bundle.nodes as NodeDef[]).find((n) => n.id === input.nodeId);
  if (!nodeDef) {
    const known = (bundle.nodes as NodeDef[]).map((n) => n.id).slice(0, 12).join(', ');
    return {
      ok: false,
      error: `Unknown nodeId '${input.nodeId}'. Bundle '${bundle.id}' has nodes: ${known}${(bundle.nodes as NodeDef[]).length > 12 ? '…' : ''}.`,
    };
  }

  // 3. Resolve outputPath via pattern expansion.
  const itemId = input.itemId ?? '';
  const outputPath = applyPattern(nodeDef.outputs.pattern, {
    item_id: itemId,
    scene_id: itemId,
    shot_id: itemId,
    chunk_id: '',
  });

  // 4. Path safety: must resolve inside projectDir.
  if (isAbsolute(outputPath)) {
    return { ok: false, error: `Bundle node '${input.nodeId}' outputs.pattern is absolute ('${outputPath}') — refusing.` };
  }
  const targetAbs = resolve(input.projectDir, outputPath);
  const projectAbs = resolve(input.projectDir);
  const rel = relative(projectAbs, targetAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Node '${input.nodeId}' outputPath resolves to '${targetAbs}' which is outside the project dir — refusing as path traversal.`,
    };
  }

  const bytes = input.content;

  // 5. Blast-radius gate.
  const target: CascadeTarget = {
    nodeId: input.nodeId,
    ...(itemId ? { itemId } : {}),
  };
  const downstreamCascade = cascadeDownstreamKeys(input.projectDir, bundle, target);
  const fanOutCollections = (bundle.nodes as NodeDef[])
    .filter((n) => n.itemSource === input.nodeId)
    .map((n) => n.id);
  const isFanOutSourceWholeEdit = !itemId && fanOutCollections.length > 0;
  const highBlast = isFanOutSourceWholeEdit || downstreamCascade.length > HIGH_BLAST;
  if (highBlast && !input.confirm) {
    const downstreamList = downstreamCascade
      .map((k) => (k.itemId !== undefined ? `${k.nodeId}:${k.itemId}` : k.nodeId))
      .slice(0, 20);
    const more = downstreamCascade.length > 20 ? ` …and ${downstreamCascade.length - 20} more` : '';
    const steer = isFanOutSourceWholeEdit
      ? `\n\n'${input.nodeId}' is the SOURCE the ${fanOutCollections.join(', ')} node(s) fan out over — overwriting it re-renders EVERY item. ` +
        `To change ONE shot's look, edit that shot's own node instead (e.g. dhee_critique_node or dhee_write_node_content on 'shot_image_prompt' with itemId='<shot>'), which cascades only that shot. ` +
        `Only overwrite '${input.nodeId}' when you genuinely need to add / remove / reorder items.`
      : `\n\nThis is a large cascade. If you meant to change one item, target that item's node with an itemId instead.`;
    const preview =
      `Preview — overwriting '${input.nodeId}'${itemId ? ` (item: ${itemId})` : ''} would invalidate ` +
      `${downstreamCascade.length} downstream entr${downstreamCascade.length === 1 ? 'y' : 'ies'}: ` +
      `${downstreamList.join(', ')}${more}.${steer}\n\n` +
      `Nothing was written. Re-call with confirm=true to proceed anyway.`;
    return { ok: true, status: 'preview', preview, downstream: downstreamCascade };
  }

  // Open the event log up front so preserve calls can emit version.added.
  const log = openEventLog(input.projectDir);

  mkdirSync(dirname(targetAbs), { recursive: true });
  // Non-destructive overwrite: preserve prior canonical as a versioned sibling.
  const targetPreserved = preserveAsVersion(targetAbs);
  if (targetPreserved) {
    const relPreserved = relative(resolve(input.projectDir), targetPreserved);
    log.append({
      kind: 'version.added',
      actor: 'agent',
      branchId: 'main',
      payload: {
        nodeId: input.nodeId,
        ...(itemId ? { itemId } : {}),
        versionId: `preserved-${Date.now()}-${input.nodeId}${itemId ? '-' + itemId : ''}`,
        outputPath: relPreserved,
        source: 'runner',
        reason: 'preserved on overwrite by writeNodeContent',
      },
    });
  }
  writeFileSync(targetAbs, bytes);

  // 6. Update walkState: mark this node completed (tool=user) + invalidate downstream.
  const pj = readProjectJson(input.projectDir);
  const walkState: WalkState = pj.walkState ?? {};
  walkState.nodes = walkState.nodes ?? {};
  walkState.lastInvalidatedIds = walkState.lastInvalidatedIds ?? [];
  const key = itemId ? `${input.nodeId}:${itemId}` : input.nodeId;
  walkState.nodes[key] = {
    status: 'completed',
    outputPath,
    completedAt: new Date().toISOString(),
    generation: { tool: 'user', toolVersion: '0.1.0' },
  };

  const invalidatedKeys: string[] = [];
  const downstreamNodeIdsSeen = new Set<string>();
  for (const dk of downstreamCascade) {
    const dKey = dk.itemId !== undefined ? `${dk.nodeId}:${dk.itemId}` : dk.nodeId;
    downstreamNodeIdsSeen.add(dk.nodeId);
    const entry = walkState.nodes[dKey];
    if (!entry) continue;
    const op = entry.outputPath;
    if (typeof op === 'string' && op.length > 0) {
      const abs = resolve(input.projectDir, op);
      try {
        const preserved = preserveAsVersion(abs);
        if (preserved) {
          const relPreserved = relative(resolve(input.projectDir), preserved);
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
              reason: `preserved by cascade from ${input.nodeId} override`,
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
  for (const downId of downstreamNodeIdsSeen) {
    if (!walkState.lastInvalidatedIds.includes(downId)) {
      walkState.lastInvalidatedIds.push(downId);
    }
  }
  pj.walkState = walkState;
  writeProjectJson(input.projectDir, pj);

  // 7. Append events for audit.
  log.append({
    kind: 'node.completed',
    actor: 'agent',
    branchId: 'main',
    payload: {
      nodeId: input.nodeId,
      ...(itemId ? { itemId } : {}),
      versionId: `user-${Date.now()}`,
      outputPath,
      generation: {
        tool: 'user',
        toolVersion: '0.1.0',
        cached: false,
      },
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
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
        reason: `cascade from user override of ${input.nodeId}`,
      },
    });
  }

  const message =
    `Wrote ${bytes.length} bytes to ${outputPath} for ${key}. ` +
    `Invalidated ${invalidatedKeys.length} downstream entr${invalidatedKeys.length === 1 ? 'y' : 'ies'} ` +
    `(${[...downstreamNodeIdsSeen].join(', ') || 'none'}). Call dhee_run_bundle to cascade.`;

  return {
    ok: true,
    status: 'written',
    outputPath,
    bytesWritten: bytes.length,
    invalidatedKeys,
    invalidatedNodeIds: [...downstreamNodeIdsSeen],
    message,
  };
}
