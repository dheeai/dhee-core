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
import { deriveItemId } from './itemId.js';
import { diffPlanItems, extractPlanItems } from './planItemDiff.js';
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
  /**
   * Set by applyPlanItemEdit (dhee_add_item / dhee_remove_item) — the
   * sanctioned membership-change path. Bypasses the agentEditable
   * membership hard-block (which otherwise refuses item add/remove made
   * through the raw write path). Never set this from a user-facing tool.
   */
  viaPlanItemEdit?: boolean;
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
  for (const n of bundle.nodes) {
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

interface ItemAwareCascade {
  /** True when item-aware diffing applied (all items id-keyed + JSON parsed). */
  applied: boolean;
  /** Whether the diff added or removed an item (membership change). */
  membershipChanged: boolean;
  /** Item-scoped downstream to invalidate (empty for a pure add). */
  downstream: CascadeTarget[];
}

/**
 * Item-aware cascade for a plan-node whole-write (#147). Instead of
 * invalidating an entire downstream collection when a plan node changes,
 * diff the prior vs new plan PER fan-out collection (each collection may
 * fan out over a different array — characters_plan→`characters`,
 * scenes_plan→`shots`) and invalidate ONLY the changed/removed items'
 * instances + their transitive downstream. Untouched siblings (and their
 * generated files) survive.
 *
 * Entry point is the COLLECTION instance `C:itemId` — a real node in the
 * event log with real deps — NOT a synthetic `plan:itemId` (which never
 * completed and has no edges). Transitivity from C:itemId reaches shot
 * images, clips, final video, etc.
 *
 * Bails (`applied=false`) when either side isn't parseable JSON or any
 * item in a fanned-out array lacks a derivable id (e.g. a raw scenes_plan
 * the LLM emitted before normalizeShotIds stamped shot ids) — the caller
 * falls back to the coarse cascade so invalidation is never silently a
 * no-op.
 */
function computeItemAwareCascade(
  projectDir: string,
  bundle: DagBundle,
  planNodeId: string,
  fanOutCollections: NodeDef[],
  priorJson: unknown,
  newJson: unknown,
): ItemAwareCascade {
  const allKeyed = (items: ReturnType<typeof extractPlanItems>): boolean =>
    items.every((it) => deriveItemId(it) !== '');

  const acc = new Map<string, CascadeTarget>();
  const put = (t: CascadeTarget) =>
    acc.set(t.itemId !== undefined ? `${t.nodeId}:${t.itemId}` : t.nodeId, t);

  let membershipChanged = false;
  for (const col of fanOutCollections) {
    const itemKey = col.itemKey;
    const oldItems = extractPlanItems(priorJson, itemKey);
    const newItems = extractPlanItems(newJson, itemKey);
    if (!allKeyed(oldItems) || !allKeyed(newItems)) {
      return { applied: false, membershipChanged: false, downstream: [] };
    }
    const d = diffPlanItems(priorJson, newJson, itemKey);
    if (d.added.length > 0 || d.removed.length > 0) membershipChanged = true;
    for (const x of [...d.removed, ...d.changed]) {
      put({ nodeId: col.id, itemId: x });
      for (const t of cascadeDownstreamKeys(projectDir, bundle, { nodeId: col.id, itemId: x })) {
        put(t);
      }
    }
  }
  // Drop the plan node itself if any cascade looped back to it.
  acc.delete(planNodeId);
  return { applied: true, membershipChanged, downstream: [...acc.values()] };
}

/** Parse a Buffer/string as JSON; undefined when not valid JSON. */
function tryParseJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Read + parse a file as JSON; undefined when missing or unparseable. */
function tryReadJsonFile(absPath: string): unknown {
  try {
    if (!existsSync(absPath)) return undefined;
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
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
  const nodeDef = (bundle.nodes).find((n) => n.id === input.nodeId);
  if (!nodeDef) {
    const known = (bundle.nodes).map((n) => n.id).slice(0, 12).join(', ');
    return {
      ok: false,
      error: `Unknown nodeId '${input.nodeId}'. Bundle '${bundle.id}' has nodes: ${known}${(bundle.nodes).length > 12 ? '…' : ''}.`,
    };
  }

  // 3. Resolve outputPath via pattern expansion.
  const itemId = input.itemId ?? '';

  // Guard (a): a per-item (collection) node MUST carry an itemId. The
  // pattern interpolates {{item_id}}/{{scene_id}}/{{shot_id}}; without one
  // it collapses to a junk path (e.g. 'assets/images/characters/.png')
  // that nothing reads — yet the write would "succeed" silently. Fail
  // loud. (This is the concept-car bug: an image written to '.png' while
  // the real reference was never replaced.)
  const PER_ITEM_PLACEHOLDER = /\{\{(item_id|scene_id|shot_id)\}\}/;
  if (!itemId && PER_ITEM_PLACEHOLDER.test(nodeDef.outputs.pattern)) {
    return {
      ok: false,
      error:
        `Node '${input.nodeId}' is a per-item node — pass itemId for the specific item ` +
        `(or use dhee_add_item to add a new one). Pattern: '${nodeDef.outputs.pattern}'.`,
    };
  }

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

  // 5. Cascade computation + blast-radius gate.
  const target: CascadeTarget = {
    nodeId: input.nodeId,
    ...(itemId ? { itemId } : {}),
  };
  const fanOutCollectionDefs = (bundle.nodes).filter(
    (n) => n.itemSource === input.nodeId,
  );
  const fanOutCollections = fanOutCollectionDefs.map((n) => n.id);
  const agentEditableIds = new Set(
    (bundle.nodes).filter((n) => n.agentEditable).map((n) => n.id),
  );
  const isFanOutSourceWholeEdit = !itemId && fanOutCollectionDefs.length > 0;

  // Prefer ITEM-AWARE invalidation for a plan-node whole edit: only the
  // changed/removed items' downstream is invalidated; untouched siblings
  // (and their files) survive. Falls back to the coarse cascade when the
  // diff can't be computed (non-JSON, or items without derivable ids).
  let downstreamCascade: CascadeTarget[];
  let itemAware = false;
  if (isFanOutSourceWholeEdit) {
    const priorJson = tryReadJsonFile(targetAbs);
    const newJson = tryParseJson(bytes);
    const ia =
      priorJson !== undefined && newJson !== undefined
        ? computeItemAwareCascade(
            input.projectDir,
            bundle,
            input.nodeId,
            fanOutCollectionDefs,
            priorJson,
            newJson,
          )
        : { applied: false as const, membershipChanged: false, downstream: [] };
    if (ia.applied) {
      itemAware = true;
      // Guard (b): membership hard-block. Adding/removing items through
      // the raw write path is refused on an agentEditable plan node —
      // that's what dhee_add_item / dhee_remove_item are for (they set
      // viaPlanItemEdit to pass). Editing an existing item's fields is
      // still allowed (no membership change).
      if (nodeDef.agentEditable && ia.membershipChanged && !input.viaPlanItemEdit) {
        return {
          ok: false,
          error:
            `'${input.nodeId}' is agent-editable: use dhee_add_item / dhee_remove_item to change ` +
            `which items exist. (dhee_write_node_content may only edit an existing item's fields here.)`,
        };
      }
      downstreamCascade = ia.downstream;
    } else {
      downstreamCascade = cascadeDownstreamKeys(input.projectDir, bundle, target);
    }
  } else {
    downstreamCascade = cascadeDownstreamKeys(input.projectDir, bundle, target);
  }

  // With item-aware diffing applied, a fan-out-source edit is no longer
  // auto-high-blast — a scoped add/remove touches few (or zero) items.
  const highBlast =
    (isFanOutSourceWholeEdit && !itemAware) || downstreamCascade.length > HIGH_BLAST;
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
    // User-authored plan barrier (#147 Gap 2): never wipe a hand-authored
    // agentEditable PLAN node (built via dhee_add_item) on an upstream
    // cascade — that would re-fire its llm.generate and erase the user's
    // items. Scoped to agentEditable so the prior contract still holds: a
    // user-pinned SHOT downstream of a character DOES re-render when the
    // character changes (it isn't agentEditable). Only an explicit
    // regenerate clears an agentEditable plan node.
    if (entry.generation?.tool === 'user' && agentEditableIds.has(dk.nodeId)) continue;
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
    `(${[...downstreamNodeIdsSeen].join(', ') || 'none'}). Call dhee_start_run to cascade.`;

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
