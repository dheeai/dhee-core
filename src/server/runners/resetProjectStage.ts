/**
 * In-process project reset. Replaces the `pnpm tsx scripts/reset-project.ts`
 * shell-out for hosts (pi-agent, packaged desktop) that don't have pnpm +
 * tsx + scripts/ available at runtime.
 *
 * Mirrors `scripts/reset-project.ts` main() exactly, but:
 *   - takes structured opts instead of process.argv
 *   - throws ResetProjectError instead of process.exit
 *   - streams progress through `onLog` instead of console.log
 *   - returns counts instead of printing them
 *
 * Phase numbering tracks the script comments so future readers can
 * cross-reference both files.
 *
 * Used by:
 *   - pi-agent `dhee_reset` tool (replaces runScript shell-out)
 *   - scripts/reset-project.ts (delegates to this so dev + prod share
 *     a single source of truth)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_ALIASES, TEMPLATE_DEPS } from '../../core/planner/stages.js';
import { resetSchemaStage } from '../../core/project/resetSchemaStage.js';
import { atomicWriteFileSync } from '../../utils/atomicWrite.js';

export class ResetProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetProjectError';
  }
}

interface ExecutionNode {
  id: string;
  typeId: string;
  itemId?: string;
  status: string;
  displayName: string;
  isExpensive: boolean;
  isCollection: boolean;
  dependencies: string[];
  dependents: string[];
  error?: string;
  completedAt?: number;
  startedAt?: number;
  outputPath?: string;
  promptPath?: string;
  artifactId?: string;
}

export interface ResetProjectStageOpts {
  /** Where projects live (`getProjectsDir()` for the host). */
  basePath: string;
  /** Project name (folder is `<name>.dhee`). */
  projectName: string;
  /** Stage alias from STAGE_ALIASES (e.g. `shot_image`, `scene_video_prompt`). */
  stage: string;
  /**
   * Wipe `executorState` entirely before applying the reset. Use when
   * stale per-item nodes from a previous run (e.g. 4→7 scene
   * restructure) leak into the new graph.
   */
  clean?: boolean | undefined;
  /** Optional progress sink for chat / TUI surfaces. */
  onLog?: ((line: string) => void) | undefined;
}

export interface ResetProjectStageResult {
  /** Type-level nodes set back to pending. */
  resetCount: number;
  /** Per-item nodes removed (will be re-expanded on next run). */
  removedCount: number;
  /** Number of shot schema slots cleared by resetSchemaStage. */
  schemaCleared: number;
  /** Number of distinct shots affected by schema clearing. */
  schemaShotsAffected: number;
  remainingNodes: number;
  completedNodes: number;
  pendingNodes: number;
  /** typeIds that were considered for reset (incl. transitively downstream). */
  resetTypes: string[];
  /** Every log line that was emitted, also forwarded via onLog if provided. */
  log: string[];
}

/**
 * Compute the full set of types to reset by traversing the dependency
 * graph downstream. Given a starting type, finds all types that
 * directly or transitively depend on it.
 *
 * Mirrors the helper in scripts/reset-project.ts (kept private here
 * since callers should use resetProjectStage as the entry point).
 */
function computeResetTypes(startType: string): string[] {
  const dependents: Record<string, string[]> = {};
  for (const [type, deps] of Object.entries(TEMPLATE_DEPS)) {
    for (const dep of deps) {
      if (!dependents[dep]) dependents[dep] = [];
      dependents[dep].push(type);
    }
  }
  const result = new Set<string>([startType]);
  const queue = [startType];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of dependents[current] ?? []) {
      if (!result.has(dependent)) {
        result.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return Array.from(result);
}

const COLLECTION_TYPES = new Set([
  'character', 'setting', 'object', 'scene',
  'character_image', 'setting_image', 'object_image',
  // Hierarchical breakdown collections — scene_shot_plan + shot_breakdown
  // were missing from this set, so reset never recreated their type-level
  // collection nodes. After a reset to plot, the graph had no
  // scene_shot_plan or shot_breakdown nodes at all → expansion never
  // produced per-items → downstream collections (scene_video_prompt and
  // everything below) had no matching upstream and got marked skipped
  // via the unreachable-cascade sweep. Observed on noir-3 today:
  // pipeline ran plot → story → characters/settings/scenes → ref images
  // and then stalled at 20/26 because the shot pipeline had nothing to
  // build from. See ExecutorAgent.ts:5158 cascade for the symptom.
  'scene_shot_plan', 'shot_breakdown',
  'scene_video_prompt', 'shot_image_prompt', 'shot_motion_directive',
  // shot_image_last_frame is also a per-shot collection; reset must
  // recreate its type-level node so the executor can expand it.
  'shot_image', 'shot_image_last_frame', 'shot_video',
]);

const MATCHING_SOURCE: Record<string, string[]> = {
  'scene_video_prompt': ['scene'],
  'character_image': ['character'],
  'setting_image': ['setting'],
  // Same omission as COLLECTION_TYPES — without these entries, the
  // resetProjectStage post-recreate sweep doesn't know which upstream
  // matching-type to wire scene_shot_plan / shot_breakdown to.
  'scene_shot_plan': ['scene'],
  'shot_breakdown': ['scene'],
  'shot_image_prompt': ['scene'],
  'shot_motion_directive': ['shot_image_prompt', 'scene'],
  'shot_image': ['shot_image_prompt', 'scene'],
  'shot_image_last_frame': ['shot_image_prompt', 'scene'],
  'shot_video': ['shot_image', 'shot_motion_directive', 'shot_image_prompt', 'scene'],
};

export function resetProjectStage(
  opts: ResetProjectStageOpts,
): ResetProjectStageResult {
  const log: string[] = [];
  const push = (line: string): void => {
    log.push(line);
    opts.onLog?.(line);
  };

  // ── Validate stage ───────────────────────────────────────────────
  const aliasValue = STAGE_ALIASES[opts.stage];
  if (!aliasValue || aliasValue.length === 0) {
    throw new ResetProjectError(
      `Unknown stage: ${opts.stage}. Valid stages: ${Object.keys(STAGE_ALIASES).join(', ')}`,
    );
  }

  const startTypes = aliasValue;
  const resetTypes = [
    ...new Set(startTypes.flatMap((t) => computeResetTypes(t))),
  ];
  push(
    `Reset types (from ${opts.stage} → ${startTypes.join(', ')}): ${resetTypes.join(', ')}`,
  );

  // ── Locate project ───────────────────────────────────────────────
  const projectDir = join(opts.basePath, `${opts.projectName}.dhee`);
  const projectPath = join(projectDir, 'project.json');
  if (!existsSync(projectPath)) {
    throw new ResetProjectError(`Project not found: ${projectPath}`);
  }

  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Record<
    string,
    unknown
  > & {
    executorState?: {
      nodes?: Record<string, ExecutionNode>;
      completedAt?: number;
      updatedAt?: number;
    };
    currentPhase?: string;
  };
  const nodes: Record<string, ExecutionNode> = project.executorState?.nodes ?? {};
  if (Object.keys(nodes).length === 0) {
    throw new ResetProjectError('No executor state found in project');
  }

  const resetTypeSet = new Set(resetTypes);
  let resetCount = 0;
  let removedCount = 0;

  // ── Phase 1: Identify nodes to reset vs remove ───────────────────
  const nodesToRemove: string[] = [];
  const nodesToReset: string[] = [];
  for (const [nid, node] of Object.entries(nodes)) {
    if (!resetTypeSet.has(node.typeId)) continue;
    if (node.itemId !== undefined) {
      nodesToRemove.push(nid);
    } else {
      nodesToReset.push(nid);
    }
  }

  // ── Phase 2: Disconnect output files (preserve on disk) ──────────
  for (const nid of [...nodesToReset, ...nodesToRemove]) {
    const node = nodes[nid]!;
    if (node.outputPath) {
      push(`  Disconnected: ${node.outputPath}`);
    }
  }

  // ── Phase 3: Remove per-item nodes + clean references ────────────
  for (const nid of nodesToRemove) {
    for (const otherNode of Object.values(nodes)) {
      otherNode.dependencies = otherNode.dependencies.filter((d) => d !== nid);
      otherNode.dependents = otherNode.dependents.filter((d) => d !== nid);
    }
    delete nodes[nid];
    removedCount++;
  }

  // ── Phase 4: Reset type-level nodes to pending ───────────────────
  for (const nid of nodesToReset) {
    const node = nodes[nid]!;
    node.status = 'pending';
    node.outputPath = undefined;
    // Clearing promptPath ensures next run regenerates the prompt;
    // otherwise the executor's media-node fast path skips LLM regen.
    node.promptPath = undefined;
    node.startedAt = undefined;
    node.completedAt = undefined;
    node.error = undefined;
    node.artifactId = undefined;
    if (COLLECTION_TYPES.has(node.typeId)) {
      node.isCollection = true;
    }
    resetCount++;
  }

  // ── Phase 5: Recreate collection nodes ───────────────────────────
  for (const typeId of resetTypes) {
    if (!COLLECTION_TYPES.has(typeId)) continue;

    if (nodes[typeId]) delete nodes[typeId];
    for (const nid of Object.keys(nodes)) {
      if (nodes[nid]!.typeId === typeId) delete nodes[nid];
    }

    const typeDeps = TEMPLATE_DEPS[typeId] ?? [];
    const sourceTypes = MATCHING_SOURCE[typeId] ?? [];
    let matchingItems: Array<{ itemId: string; name: string }> | null = null;
    for (const sourceType of sourceTypes) {
      const sourceNodes = Object.values(nodes).filter(
        (n) =>
          n.typeId === sourceType &&
          n.itemId &&
          (n.status === 'completed' || n.status === 'pending'),
      );
      if (sourceNodes.length > 0) {
        matchingItems = sourceNodes.map((n) => ({
          itemId: n.itemId!,
          name: n.displayName.split(': ').pop() ?? n.itemId!,
        }));
        break;
      }
    }

    if (matchingItems && matchingItems.length > 0) {
      push(`  Recreating ${matchingItems.length} per-item nodes for: ${typeId}`);
      for (const item of matchingItems) {
        const itemNodeId = `${typeId}:${item.itemId}`;
        const displayName = `${typeId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}: ${item.name}`;

        const wireDeps: string[] = [];
        for (const depType of typeDeps) {
          const matchingNode = nodes[`${depType}:${item.itemId}`];
          if (matchingNode) {
            wireDeps.push(matchingNode.id);
          } else {
            const allNodes = Object.values(nodes).filter(
              (n) => n.typeId === depType && n.itemId,
            );
            for (const n of allNodes) {
              if (!wireDeps.includes(n.id)) wireDeps.push(n.id);
            }
            if (allNodes.length === 0 && nodes[depType]) {
              wireDeps.push(depType);
            }
          }
        }

        const newNode: ExecutionNode = {
          id: itemNodeId,
          typeId,
          itemId: item.itemId,
          status: 'pending',
          displayName,
          isExpensive: false,
          isCollection:
            ['scene_video_prompt', 'shot_image_prompt', 'shot_image', 'shot_video'].includes(typeId) &&
            !item.itemId.includes('shot_'),
          dependencies: wireDeps,
          dependents: [],
        };
        nodes[itemNodeId] = newNode;

        for (const depId of wireDeps) {
          if (nodes[depId] && !nodes[depId].dependents.includes(itemNodeId)) {
            nodes[depId].dependents.push(itemNodeId);
          }
        }
        resetCount++;
      }
    } else {
      push(`  Recreating collection node: ${typeId}`);
      const wireDeps: string[] = [];
      for (const depType of typeDeps) {
        if (nodes[depType]) wireDeps.push(depType);
        const perItemNodes = Object.values(nodes).filter(
          (n) => n.typeId === depType && n.itemId,
        );
        for (const pin of perItemNodes) {
          if (!wireDeps.includes(pin.id)) wireDeps.push(pin.id);
        }
      }
      const newNode: ExecutionNode = {
        id: typeId,
        typeId,
        status: 'pending',
        displayName: typeId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        isExpensive: false,
        isCollection: true,
        dependencies: wireDeps,
        dependents: [],
      };
      nodes[typeId] = newNode;
      resetCount++;
    }

    // Wire downstream dependents for all new nodes of this type
    const newNodesOfType = Object.values(nodes).filter((n) => n.typeId === typeId);
    for (const newNode of newNodesOfType) {
      for (const otherNode of Object.values(nodes)) {
        if (otherNode.id === newNode.id) continue;
        const otherDeps = TEMPLATE_DEPS[otherNode.typeId] ?? [];
        if (otherDeps.includes(typeId)) {
          if (!otherNode.dependencies.includes(newNode.id)) {
            otherNode.dependencies.push(newNode.id);
          }
          if (!newNode.dependents.includes(otherNode.id)) {
            newNode.dependents.push(otherNode.id);
          }
        }
      }
    }
  }

  // ── Phase 6: Output files preserved (NOT deleted) ────────────────
  push('  Output files preserved (not deleted)');

  // ── Phase 7: Clean up stale references ───────────────────────────
  const nodeIds = new Set(Object.keys(nodes));
  for (const node of Object.values(nodes)) {
    node.dependencies = Array.from(
      new Set(node.dependencies.filter((d) => nodeIds.has(d))),
    );
    node.dependents = Array.from(
      new Set(node.dependents.filter((d) => nodeIds.has(d))),
    );
  }

  // ── Phase 8 & 9: Clear completedAt, currentPhase ─────────────────
  if (project.executorState) {
    project.executorState.completedAt = undefined;
    project.executorState.updatedAt = Date.now();
  }
  project.currentPhase = undefined;

  // ── Phase 10 (--clean): wipe executorState entirely ──────────────
  if (opts.clean) {
    const beforeNodeCount = Object.keys(project.executorState?.nodes ?? {}).length;
    delete project.executorState;
    push(
      `  --clean: wiped ${beforeNodeCount} nodes from executorState (graph rebuilds on next run)`,
    );
  }

  // Schema-side reset (project.scenes tree slots).
  const schemaResult = resetSchemaStage(
    project as unknown as Record<string, unknown>,
    opts.stage,
  );

  // Persist.
  atomicWriteFileSync(projectPath, JSON.stringify(project, null, 2));

  // Summary numbers from the live `nodes` map (post-clean if --clean).
  const remaining = Object.values(nodes);
  const completedNodes = remaining.filter((n) => n.status === 'completed').length;
  const pendingNodes = remaining.filter((n) => n.status === 'pending').length;

  push('');
  push(`Reset to stage: ${opts.stage}`);
  push(`  Nodes reset to pending: ${resetCount}`);
  push(`  Per-item nodes removed: ${removedCount}`);
  push('  Output files preserved on disk (disconnected from graph)');
  push(
    `  Final state: ${completedNodes} completed, ${pendingNodes} pending, ${remaining.length} total`,
  );
  if (schemaResult && schemaResult.cleared > 0) {
    push(
      `  Schema slots cleared: ${schemaResult.cleared} (across ${schemaResult.shotsAffected} shots, archived to shot.history)`,
    );
  }

  return {
    resetCount,
    removedCount,
    schemaCleared: schemaResult?.cleared ?? 0,
    schemaShotsAffected: schemaResult?.shotsAffected ?? 0,
    remainingNodes: remaining.length,
    completedNodes,
    pendingNodes,
    resetTypes,
    log,
  };
}
