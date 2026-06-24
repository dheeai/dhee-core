/**
 * walkState — per-project DAG state, owned by the walker.
 *
 * Lives at `project.json.walkState`. Same in-file location as the
 * legacy `executorState` but a different shape (and different owner —
 * the walker writes here exclusively; no other code path should touch
 * it). Single-owner discipline avoids the field-stripping bug class
 * that bit the executor↔saveProject boundary during the hybrid era.
 *
 * The walker reads walkState on entry, drops entries for nodes no
 * longer in the bundle (handles bundle-author renames + new nodes),
 * runs whatever's still pending, and writes the updated state after
 * every node completion (so a crash mid-run leaves resumable state).
 *
 * Note: project.json is loaded as a generic object; we never lose
 * fields owned by other code paths. The whole object is written back
 * with only walkState updated.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type NodeRunStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface NodeStateEntry {
  status: NodeRunStatus;
  /** Bundle output path, relative to projectDir (set on completion). */
  outputPath?: string;
  /** For collection instances: the resolved item id (e.g. 'scene_1_shot_3'). */
  itemId?: string;
  /** Most recent error message (only set when status === 'failed'). */
  error?: string;
  /** Unix-ms timestamps. */
  startedAt?: number;
  completedAt?: number;
  /** Arbitrary runner-emitted metadata (e.g. cached:true, model:'gpt-4'). */
  metadata?: Record<string, unknown>;
  /**
   * Content hash of the node's DEFINITION at completion — runner config +
   * the CONTENTS of referenced bundle files (promptTemplate, workflowPath,
   * outputSchema, manifestPath, scriptPath) + wiring. On the next run a
   * pre-walk sweep recomputes this; if it differs (a template/workflow/
   * config edit), the node and its downstream are invalidated and re-run,
   * so edits are picked up without a manual project wipe. See dhee-core#171.
   */
  defFingerprint?: string;
  /**
   * Who produced this artifact. Default is the runner tool name (the
   * walker fills this on completion). The special value 'user' marks
   * the entry as user-overridden via dhee_write_node_content — the
   * walker treats user-overrides as pinned and refuses to re-fire the
   * runner on upstream cascades. The only way to clear the pin is an
   * explicit runOnly / invalidate.
   */
  generation?: {
    tool?: string;
    toolVersion?: string;
  };
}

export interface WalkState {
  /** Which bundle source URI was walked (e.g. 'built-in:narrative_relay'). */
  bundleSource: string;
  bundleVersion: string;
  engineVersion: string;
  /**
   * Per-node-instance state. Key = `nodeId` (for stages) or
   * `nodeId:itemId` (for collections). Looking up status uses both
   * forms — see walker's resume logic.
   */
  nodes: Record<string, NodeStateEntry>;
  /**
   * Node ids set by the most-recent invalidate. `dhee_run_to scope=
   * last_invalidated` reads this and passes it as runOnly. Kept on
   * state (rather than computed on-the-fly) so the user's "redo this
   * one thing" intent is durable across runs.
   */
  lastInvalidatedIds: string[];
}

function projectJsonPath(projectDir: string): string {
  return join(projectDir, 'project.json');
}

/**
 * Load walkState from project.json. Returns null when:
 *   - project.json doesn't exist
 *   - project.json has no walkState field
 *   - walkState field is malformed (not an object)
 *
 * Walker treats null as "no prior state, start fresh." Malformed is
 * treated the same as missing — the alternative (refuse to run) would
 * leave the user stuck whenever they hand-edit project.json badly.
 */
export function loadWalkState(projectDir: string): WalkState | null {
  const p = projectJsonPath(projectDir);
  if (!existsSync(p)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ws = raw['walkState'];
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return null;
  const candidate = ws as Partial<WalkState>;
  if (
    !candidate.nodes ||
    typeof candidate.nodes !== 'object' ||
    Array.isArray(candidate.nodes)
  ) {
    return null;
  }
  return {
    bundleSource: candidate.bundleSource ?? '',
    bundleVersion: candidate.bundleVersion ?? '',
    engineVersion: candidate.engineVersion ?? '',
    nodes: candidate.nodes as Record<string, NodeStateEntry>,
    lastInvalidatedIds: Array.isArray(candidate.lastInvalidatedIds)
      ? candidate.lastInvalidatedIds
      : [],
  };
}

/**
 * Save walkState back into project.json. Reads the existing JSON,
 * merges in the walkState field (preserving every other field), writes
 * atomically (temp + rename would be ideal but not strictly required
 * yet — node.js writeFileSync is reasonably atomic on POSIX).
 *
 * Creates project.json if missing (with just an id and the walkState).
 */
export function saveWalkState(projectDir: string, state: WalkState): void {
  const p = projectJsonPath(projectDir);
  let existing: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      existing = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const updated: Record<string, unknown> = { ...existing, walkState: state };
  writeFileSync(p, JSON.stringify(updated, null, 2), 'utf-8');
}

/**
 * Build an empty walkState for a bundle. Initial node entries are all
 * 'pending'. Called when no prior walkState exists, or when the
 * existing one is incompatible (bundle source changed).
 */
export function initWalkState(opts: {
  bundleSource: string;
  bundleVersion: string;
  engineVersion: string;
}): WalkState {
  return {
    bundleSource: opts.bundleSource,
    bundleVersion: opts.bundleVersion,
    engineVersion: opts.engineVersion,
    nodes: {},
    lastInvalidatedIds: [],
  };
}

/**
 * Drop entries for nodes no longer present in `validNodeIds`. Returns
 * the count of pruned entries (informational). The bundle author may
 * have renamed a node between runs; we don't want zombie entries
 * sticking around forever.
 */
export function pruneStaleEntries(
  state: WalkState,
  validNodeIds: Set<string>,
): number {
  let pruned = 0;
  for (const key of Object.keys(state.nodes)) {
    // Key form: 'nodeId' (stages) or 'nodeId:itemId' (collections).
    // The bundle node id is the prefix up to the first ':'.
    const baseNodeId = key.split(':')[0] ?? key;
    if (!validNodeIds.has(baseNodeId)) {
      delete state.nodes[key];
      pruned++;
    }
  }
  return pruned;
}
