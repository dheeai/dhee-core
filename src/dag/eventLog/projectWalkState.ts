/**
 * projectWalkState — pure fold from event log to legacy WalkState shape.
 *
 * Bridges the new event-sourced source-of-truth to the existing
 * walkState reader contract (dheeGetStatus, desktop's bundleCapability,
 * IPC handlers) — so those consumers keep working unchanged while the
 * system migrates underneath them.
 *
 * Per-event handling:
 *   - bundle.bound: seeds bundleSource/Version/engineVersion
 *   - node.started: in_progress entry, startedAt from event.ts
 *   - node.completed: completed entry with outputPath + versions[]
 *     (latest auto-selected); accumulates across re-runs
 *   - node.failed: failed entry with error
 *   - node.invalidated: removes the entry; adds bare nodeId to
 *     lastInvalidatedIds (the walker's "redo this one thing" hook)
 *   - version.selected: flips the chosen versionId for a node[:itemId];
 *     outputPath is repointed at the selected version's path
 *
 * Branch isolation: by default the fold only sees events on the 'main'
 * branch. Pass { branchId } to project a different branch. Branches
 * inherit the parent's prefix via the linear event log (see Phase 5).
 */
import type {
  DheeEvent,
  NodeCompletedPayload,
  NodeFailedPayload,
  NodeInvalidatedPayload,
  NodeStartedPayload,
  VersionSelectedPayload,
  BundleBoundPayload,
} from './events.js';

import type { NodeStateEntry as LegacyNodeStateEntry, NodeRunStatus, WalkState as LegacyWalkState } from '../walkState.js';

/** Per-version record exposed in the projection (the candidate tray). */
export interface NodeVersionEntry {
  versionId: string;
  outputPath: string;
  artifact?: NodeCompletedPayload['artifact'];
  generation?: NodeCompletedPayload['generation'];
  createdAt: number;
}

/**
 * Projected NodeStateEntry — extends the legacy shape with `versions[]`
 * and `selectedVersionId`. Legacy readers can ignore the new fields and
 * keep using `outputPath` / `status` as before (they always reflect the
 * selected version).
 */
export interface ProjectedNodeStateEntry extends LegacyNodeStateEntry {
  versions?: NodeVersionEntry[];
  selectedVersionId?: string;
}

export interface ProjectedWalkState extends LegacyWalkState {
  nodes: Record<string, ProjectedNodeStateEntry>;
}

export interface ProjectWalkStateOpts {
  /** Branch to project. Defaults to 'main'. */
  branchId?: string;
}

function keyFor(nodeId: string, itemId?: string): string {
  return itemId ? `${nodeId}:${itemId}` : nodeId;
}

export function projectWalkState(
  events: Iterable<DheeEvent>,
  opts: ProjectWalkStateOpts = {},
): ProjectedWalkState {
  const branch = opts.branchId ?? 'main';
  const state: ProjectedWalkState = {
    bundleSource: '',
    bundleVersion: '',
    engineVersion: '',
    nodes: {},
    lastInvalidatedIds: [],
  };

  // Permanent per-instance version history — survives node.invalidated.
  // The walkState entry is cleared on invalidate, but the version tray
  // is the audit log of all generations and must accumulate.
  const versionsHistory = new Map<string, NodeVersionEntry[]>();

  for (const e of events) {
    if (e.branchId !== branch) continue;

    switch (e.kind) {
      case 'bundle.bound': {
        const p = e.payload as BundleBoundPayload;
        state.bundleSource = p.bundleSource;
        state.bundleVersion = p.bundleVersion;
        state.engineVersion = p.engineVersion;
        break;
      }

      case 'node.started': {
        const p = e.payload as NodeStartedPayload;
        const k = keyFor(p.nodeId, p.itemId);
        const prior = state.nodes[k] ?? {};
        state.nodes[k] = {
          ...prior,
          status: 'in_progress' as NodeRunStatus,
          startedAt: e.ts,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
        };
        break;
      }

      case 'node.completed': {
        const p = e.payload as NodeCompletedPayload;
        const k = keyFor(p.nodeId, p.itemId);
        const prior = state.nodes[k] ?? ({} as ProjectedNodeStateEntry);
        const newVersion: NodeVersionEntry = {
          versionId: p.versionId,
          outputPath: p.outputPath,
          ...(p.artifact ? { artifact: p.artifact } : {}),
          ...(p.generation ? { generation: p.generation } : {}),
          createdAt: e.ts,
        };
        const versions = [...(versionsHistory.get(k) ?? []), newVersion];
        versionsHistory.set(k, versions);
        state.nodes[k] = {
          ...prior,
          status: 'completed' as NodeRunStatus,
          outputPath: p.outputPath,
          completedAt: e.ts,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
          ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
          versions,
          selectedVersionId: p.versionId,
        };
        // Once a node has produced a successful output, clear it from
        // lastInvalidatedIds (the user-visible "needs redo" hint).
        state.lastInvalidatedIds = state.lastInvalidatedIds.filter((id) => id !== p.nodeId);
        break;
      }

      case 'node.failed': {
        const p = e.payload as NodeFailedPayload;
        const k = keyFor(p.nodeId, p.itemId);
        const prior = state.nodes[k] ?? {};
        state.nodes[k] = {
          ...prior,
          status: 'failed' as NodeRunStatus,
          error: p.error,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
        };
        break;
      }

      case 'node.invalidated': {
        const p = e.payload as NodeInvalidatedPayload;
        const k = keyFor(p.nodeId, p.itemId);
        delete state.nodes[k];
        if (!state.lastInvalidatedIds.includes(p.nodeId)) {
          state.lastInvalidatedIds.push(p.nodeId);
        }
        break;
      }

      case 'version.selected': {
        const p = e.payload as VersionSelectedPayload;
        const k = keyFor(p.nodeId, p.itemId);
        const entry = state.nodes[k];
        // Look up in the persistent history so we can re-select a
        // version that was produced before the most recent invalidate.
        const versions = versionsHistory.get(k) ?? entry?.versions ?? [];
        const selected = versions.find((v) => v.versionId === p.versionId);
        if (!entry || !selected) break;
        state.nodes[k] = {
          ...entry,
          versions,
          selectedVersionId: p.versionId,
          outputPath: selected.outputPath,
        };
        break;
      }

      default:
        break;
    }
  }

  return state;
}
