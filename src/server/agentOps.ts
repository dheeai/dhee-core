/**
 * Pure agent-control operations — the engine behind both the
 * `pnpm <scriptname>` CLIs (later) and the HTTP endpoints exposed
 * for external agents (pi-agent, openclaw, etc.).
 *
 * Each function takes a parsed ProjectFile, optionally mutates its
 * executorState in place, and returns a small result struct. The
 * caller is responsible for persisting `project.json` — these helpers
 * stay pure-ish so they're easy to unit-test without touching disk
 * (except for `overrideNode`, which by definition writes an artifact).
 */

import { existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import {
  resolveNodeId,
  type ExecutorState,
  type ExecutionNode,
  type ProjectFile,
} from '../core/project/projectTypes.js';

/** Per-status counts in canonical order; missing buckets are zero. */
export interface StatusCounts {
  total: number;
  completed: number;
  pending: number;
  failed: number;
  running: number;
  skipped: number;
}

export interface StatusSummary {
  title: string;
  style?: string;
  targetDuration?: number;
  inputType?: string;
  templateId?: string;
  currentPhase?: string;
  totalNodes: number;
  counts: Omit<StatusCounts, 'total'>;
  byType: Record<string, StatusCounts>;
  failedNodes: Array<{ id: string; error: string }>;
}

/**
 * Compute a one-shot summary of a project's executor state. Used by
 * `pnpm status` and the GET /projects/:name/status endpoint.
 */
export function computeStatus(project: ProjectFile): StatusSummary {
  const nodes = project.executorState?.nodes ?? {};
  const allNodes = Object.values(nodes);

  const empty = (): StatusCounts => ({
    total: 0, completed: 0, pending: 0, failed: 0, running: 0, skipped: 0,
  });

  const overall = empty();
  const byType: Record<string, StatusCounts> = {};
  const failedNodes: Array<{ id: string; error: string }> = [];

  for (const node of allNodes) {
    overall.total += 1;
    if (!byType[node.typeId]) byType[node.typeId] = empty();
    const t = byType[node.typeId]!;
    t.total += 1;

    const bucket = (node.status === 'completed' ? 'completed'
      : node.status === 'pending' ? 'pending'
      : node.status === 'failed' ? 'failed'
      : node.status === 'running' ? 'running'
      : 'skipped');

    overall[bucket] += 1;
    t[bucket] += 1;

    if (node.status === 'failed') {
      failedNodes.push({ id: node.id, error: node.error ?? 'unknown error' });
    }
  }

   
  const { total: _total, ...counts } = overall;
  return {
    title: project.title,
    ...(project.style !== undefined ? { style: project.style } : {}),
    ...(project.targetDuration !== undefined ? { targetDuration: project.targetDuration } : {}),
    ...(project.inputType !== undefined ? { inputType: project.inputType } : {}),
    ...(project.templateId !== undefined ? { templateId: project.templateId } : {}),
    ...(project.currentPhase !== undefined ? { currentPhase: project.currentPhase } : {}),
    totalNodes: overall.total,
    counts,
    byType,
    failedNodes,
  };
}

export interface RegenOptions {
  /** When true, also marks every transitively downstream node as pending. */
  cascade?: boolean;
}

export interface RegenResult {
  /** Node ids that were marked pending. */
  changed: string[];
  /** Aliases the caller passed that did not resolve to any node. */
  notFound: string[];
}

/**
 * Mark nodes as pending so the next executor run regenerates them.
 * Mutates `project.executorState.nodes` in place. Caller persists.
 *
 * `cascade`: BFS through `dependents` so changes propagate (e.g. regen
 * the SVP and you almost certainly want the per-shot prompts/images/
 * videos to redo too).
 */
export function regenNodes(
  project: ProjectFile,
  aliases: string[],
  options: RegenOptions = {},
): RegenResult {
  const state = project.executorState;
  if (!state || !state.nodes) {
    throw new Error('Cannot regen — project has no executorState. Run a stage first.');
  }
  const cascade = options.cascade === true;

  const notFound: string[] = [];
  const changed = new Set<string>();

  for (const alias of aliases) {
    const nodeId = resolveNodeId(state, alias);
    if (!nodeId) { notFound.push(alias); continue; }
    changed.add(nodeId);
    if (cascade) {
      const seen = new Set<string>([nodeId]);
      const queue = [nodeId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const node = state.nodes[cur];
        if (!node) continue;
        for (const child of node.dependents ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
          changed.add(child);
        }
      }
    }
  }

  for (const id of changed) {
    const node = state.nodes[id];
    if (!node) continue;
    node.status = 'pending';
    delete node.outputPath;
    delete node.error;
    delete node.startedAt;
    delete node.completedAt;
  }

  return { changed: Array.from(changed), notFound };
}

export interface OverrideOptions {
  project: ProjectFile;
  projectDir: string;
  alias: string;
  content: string;
}

export interface OverrideResult {
  nodeId: string;
  outputPath: string;
  bytes: number;
}

/**
 * Write user-supplied content for a node and mark it completed.
 * Mirrors `pnpm override` (scripts/set-content.ts) but as a pure
 * function. Caller persists the project file.
 */
export function overrideNode(opts: OverrideOptions): OverrideResult {
  const { project, projectDir, alias, content } = opts;
  const state = project.executorState;
  if (!state || !state.nodes) {
    throw new Error('Cannot override — project has no executorState. Run a stage first.');
  }
  const nodeId = resolveNodeId(state, alias);
  if (!nodeId) throw new Error(`No matching node for alias: "${alias}"`);
  const node = state.nodes[nodeId]!;

  const outputPath = node.outputPath ?? deriveDefaultOutputPath(node);
  const fullPath = join(projectDir, outputPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);

  node.status = 'completed';
  node.outputPath = outputPath;
  node.completedAt = Date.now();
  delete node.error;

  return { nodeId, outputPath, bytes: Buffer.byteLength(content) };
}

function deriveDefaultOutputPath(node: ExecutionNode): string {
  const item = node.itemId ?? 'default';
  switch (node.typeId) {
    case 'character':         return `characters/${item}.md`;
    case 'setting':           return `settings/${item}.md`;
    case 'scene':             return `chapters/chapter_1/scenes/${item}.md`;
    case 'scene_video_prompt':return `prompts/videos/scenes/${item}.json`;
    case 'shot_image_prompt': return `prompts/images/shots/${item.replace(/scene_(\d+)_shot_(\d+)/, 'scene-$1-shot-$2')}.json`;
    case 'shot_motion_directive': return `prompts/motion/${item}.json`;
    case 'plot':              return 'chapters/chapter_1/plans/plot.md';
    case 'story':             return 'chapters/chapter_1/plans/story.md';
    case 'world_style':       return 'plans/world_style.md';
    default:                  return `overrides/${node.id.replace(/[:]/g, '_')}.txt`;
  }
}

export interface InspectResult {
  node: ExecutionNode;
  /** Whether the outputPath file exists on disk. */
  exists: boolean;
  /** True when the file is binary (image/video). content is omitted. */
  binary: boolean;
  /** UTF-8 contents for text files. Omitted for binary. */
  content?: string;
  /** Byte size of the file on disk, when it exists. */
  bytes?: number;
}

const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.mp4', '.mov', '.webm', '.gif', '.webp']);

/**
 * Read a node's metadata + content (if text). Mirrors `pnpm inspect`.
 * Throws on alias miss; returns `exists=false` when the file is gone
 * (don't throw — common after a reset).
 */
export function inspectNode(project: ProjectFile, projectDir: string, alias: string): InspectResult {
  const state = project.executorState;
  if (!state || !state.nodes) {
    throw new Error('Cannot inspect — project has no executorState. Run a stage first.');
  }
  const nodeId = resolveNodeId(state, alias);
  if (!nodeId) throw new Error(`No matching node for alias: "${alias}"`);
  const node = state.nodes[nodeId]!;

  if (!node.outputPath) {
    return { node, exists: false, binary: false };
  }

  const fullPath = join(projectDir, node.outputPath);
  if (!existsSync(fullPath)) return { node, exists: false, binary: false };

  const stat = statSync(fullPath);
  const ext = extname(fullPath).toLowerCase();
  const binary = BINARY_EXTS.has(ext);
  if (binary) {
    return { node, exists: true, binary: true, bytes: stat.size };
  }
  return {
    node,
    exists: true,
    binary: false,
    bytes: stat.size,
    content: readFileSync(fullPath, 'utf-8'),
  };
}

/**
 * Persist a project file back to disk. Convenience wrapper so
 * routes don't reimplement the JSON write everywhere. This is the
 * same write semantics the pnpm scripts have today — last-write-wins
 * if a running executor mutates the file in parallel. The HTTP path
 * adds in-process serialization via JobManager so the only race that
 * remains is between the executor and the script-style endpoint.
 */
export function persistProject(projectDir: string, project: ProjectFile): void {
  const projectJsonPath = join(projectDir, 'project.json');
  writeFileSync(projectJsonPath, JSON.stringify(project, null, 2));
}

export interface ExecutorRunningState {
  /** Nodes currently in 'running' status — there should be at most one normally. */
  runningNodeIds: string[];
}

/**
 * Quick check: is this project currently being processed by an in-flight
 * executor? Returns the running node ids if so. Used by the run-to
 * endpoint to decide whether to reject a duplicate request.
 */
export function executorRunningState(project: ProjectFile): ExecutorRunningState {
  const nodes = Object.values(project.executorState?.nodes ?? {});
  return {
    runningNodeIds: nodes.filter(n => n.status === 'running').map(n => n.id),
  };
}

// Re-export the existing types for convenience so route modules don't
// have to reach into scripts/cli-helpers themselves.
export type { ProjectFile, ExecutionNode, ExecutorState };
