/**
 * ProjectionEngine — the read+write face of the event-sourced state.
 *
 * Composes an EventLog with the projection folds, and writes the
 * back-compat walkState snapshot to project.json after every event.
 *
 * Two responsibilities:
 *   1. `appendAndProject(input)` — single entry point used by the walker,
 *      regen, agent tools, and runners. Appends to the log AND advances
 *      the walkState projection on disk so existing readers
 *      (dheeGetStatus, desktop, IPC) keep seeing fresh state.
 *   2. Lazy projections — `projection()`, `listVersions()`,
 *      `computeBranchTree()`, `computeCostLedger()` — pure folds over
 *      the log, computed on demand. No second cache file.
 *
 * Single-writer discipline: the engine is the only thing that writes to
 * the event log AND the only thing that writes the back-compat walkState
 * snapshot. Concurrency within one process is serialized by the single
 * walker (true today); cross-process locking is deferred to future work.
 *
 * Project.json field preservation: when writing the walkState snapshot,
 * the engine reads project.json, merges in `walkState`, and writes back
 * — preserving every other field (id, targetDuration, goal, …). This
 * is the same discipline `saveWalkState` already uses.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openEventLog, type EventLog } from './EventLog.js';
import type { DheeEvent, EventAppendInput, EventKind } from './events.js';
import {
  projectWalkState,
  type ProjectedWalkState,
  type ProjectWalkStateOpts,
} from './projectWalkState.js';
import { listVersions, type VersionTrayEntry, type ListVersionsOpts } from './projectVersions.js';
import { computeBranchTree, type BranchTree } from './projectBranches.js';
import { computeCostLedger, type CostLedger, type CostLedgerOpts } from './projectCost.js';

export interface ProjectionEngine {
  /** Append an event AND advance the on-disk walkState back-compat snapshot. */
  appendAndProject<K extends EventKind>(input: EventAppendInput<K>): DheeEvent<K>;

  /** Snapshot of the current walkState projection (in memory). */
  projection(opts?: ProjectWalkStateOpts): ProjectedWalkState;

  /** Version tray for an instance (lazy fold). */
  listVersions(nodeId: string, itemId?: string, opts?: ListVersionsOpts): VersionTrayEntry[];

  /** Branch tree (lazy fold). */
  computeBranchTree(): BranchTree;

  /** Cost ledger (lazy fold). */
  computeCostLedger(opts?: CostLedgerOpts): CostLedger;

  /** Underlying event log (for read-only access by other modules). */
  log(): EventLog;
}

function projectJsonPath(projectDir: string): string {
  return join(projectDir, 'project.json');
}

function writeProjectedWalkState(projectDir: string, walkState: ProjectedWalkState): void {
  const path = projectJsonPath(projectDir);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const updated: Record<string, unknown> = { ...existing, walkState };
  writeFileSync(path, JSON.stringify(updated, null, 2), 'utf-8');
}

export function openProjectionEngine(projectDir: string): ProjectionEngine {
  const eventLog = openEventLog(projectDir);

  function readAll(): DheeEvent[] {
    return [...eventLog.read()];
  }

  return {
    appendAndProject<K extends EventKind>(input: EventAppendInput<K>): DheeEvent<K> {
      const event = eventLog.append(input);
      // Advance the back-compat walkState snapshot on the event's
      // branch. (Branches each project to their own walkState shape on
      // demand via `projection({ branchId })`; the on-disk snapshot
      // tracks the EVENT's branch so resume after a kill mid-walk
      // continues on the right branch.)
      const projected = projectWalkState(readAll(), { branchId: event.branchId });
      writeProjectedWalkState(projectDir, projected);
      return event;
    },

    projection(opts: ProjectWalkStateOpts = {}): ProjectedWalkState {
      return projectWalkState(readAll(), opts);
    },

    listVersions(nodeId: string, itemId?: string, opts?: ListVersionsOpts): VersionTrayEntry[] {
      return listVersions(readAll(), nodeId, itemId, opts ?? {});
    },

    computeBranchTree(): BranchTree {
      return computeBranchTree(readAll());
    },

    computeCostLedger(opts?: CostLedgerOpts): CostLedger {
      return computeCostLedger(readAll(), opts ?? {});
    },

    log(): EventLog {
      return eventLog;
    },
  };
}
