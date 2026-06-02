/**
 * computeBranchTree — fold branch.created events into a flat list of
 * branches (with parent pointers + the event id we forked from).
 *
 * 'main' always exists implicitly with no parent. Subsequent branches
 * each declare their parentBranchId + the seq we diverged at.
 *
 * The tree is flat (list of branches) rather than a recursive node
 * shape — UIs can build hierarchy on-demand via parent pointers, and
 * the list form serializes cleanly into IPC + agent tool outputs.
 */
import type { BranchCreatedPayload, DheeEvent } from './events.js';

export interface BranchEntry {
  branchId: string;
  label?: string;
  parentBranchId?: string;
  forkedFromEventId?: string;
  createdAt?: number;
}

export interface BranchTree {
  branches: BranchEntry[];
}

export function computeBranchTree(events: Iterable<DheeEvent>): BranchTree {
  const branches: BranchEntry[] = [{ branchId: 'main' }];
  const seen = new Set<string>(['main']);

  for (const e of events) {
    if (e.kind !== 'branch.created') continue;
    const p = e.payload as BranchCreatedPayload;
    if (seen.has(p.branchId)) continue;
    seen.add(p.branchId);
    branches.push({
      branchId: p.branchId,
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.parentBranchId !== undefined ? { parentBranchId: p.parentBranchId } : {}),
      ...(p.forkedFromEventId !== undefined ? { forkedFromEventId: p.forkedFromEventId } : {}),
      createdAt: e.ts,
    });
  }

  return { branches };
}
