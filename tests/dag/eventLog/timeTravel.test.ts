/**
 * Time travel — projections can be folded over a prefix of the event
 * log to see what the project looked like at any past point.
 *
 * Failure modes:
 *   1. asOfSeq omitted → all events folded.
 *   2. asOfSeq = N → only events with seq <= N folded.
 *   3. listVersions respects asOfSeq.
 *   4. computeCostLedger respects asOfSeq.
 *   5. Rewinding past a node.completed un-completes it in the
 *      projection.
 *   6. Rewinding past a node.invalidated brings back the completed
 *      version (it un-deletes the entry).
 */
import { describe, it, expect } from 'vitest';
import type { DheeEvent } from '../../../src/dag/eventLog/events.js';
import { projectWalkState } from '../../../src/dag/eventLog/projectWalkState.js';
import { listVersions } from '../../../src/dag/eventLog/projectVersions.js';
import { computeCostLedger } from '../../../src/dag/eventLog/projectCost.js';

function ev(seq: number, kind: DheeEvent['kind'], payload: Record<string, unknown>): DheeEvent {
  return { seq, id: `e${seq}`, ts: seq, branchId: 'main', actor: 'walker', kind, payload } as unknown as DheeEvent;
}

const EVENTS: DheeEvent[] = [
  ev(1, 'node.completed', { nodeId: 'a', versionId: 'a1', outputPath: 'a.v1.md', generation: { tool: 't', toolVersion: '1', cached: false, costUsd: 0.10 } }),
  ev(2, 'node.completed', { nodeId: 'b', versionId: 'b1', outputPath: 'b.v1.md', generation: { tool: 't', toolVersion: '1', cached: false, costUsd: 0.20 } }),
  ev(3, 'node.invalidated', { nodeId: 'a' }),
  ev(4, 'node.completed', { nodeId: 'a', versionId: 'a2', outputPath: 'a.v2.md', generation: { tool: 't', toolVersion: '1', cached: false, costUsd: 0.15 } }),
];

describe('time travel — asOfSeq', () => {
  it('asOfSeq omitted → all events folded', () => {
    const s = projectWalkState(EVENTS);
    expect(s.nodes['a']?.versions?.length).toBe(2);
    expect(s.nodes['a']?.selectedVersionId).toBe('a2');
    expect(s.nodes['b']?.versions?.length).toBe(1);
  });

  it('asOfSeq = 1 → only first event seen', () => {
    const s = projectWalkState(EVENTS, { asOfSeq: 1 });
    expect(s.nodes['a']?.selectedVersionId).toBe('a1');
    expect(s.nodes['b']).toBeUndefined();
  });

  it('asOfSeq = 3 → second completion not yet visible; node "a" is in invalidated state', () => {
    const s = projectWalkState(EVENTS, { asOfSeq: 3 });
    expect(s.nodes['a']).toBeUndefined();
    expect(s.lastInvalidatedIds).toContain('a');
    expect(s.nodes['b']?.selectedVersionId).toBe('b1');
  });

  it('asOfSeq = 2 → snapshot BEFORE the invalidate; a is still completed with a1', () => {
    const s = projectWalkState(EVENTS, { asOfSeq: 2 });
    expect(s.nodes['a']?.selectedVersionId).toBe('a1');
    expect(s.nodes['a']?.versions?.length).toBe(1);
  });

  it('listVersions respects asOfSeq', () => {
    const trayAt2 = listVersions(EVENTS, 'a', undefined, { asOfSeq: 2 });
    expect(trayAt2.map((v) => v.versionId)).toEqual(['a1']);
    const trayAt4 = listVersions(EVENTS, 'a', undefined, { asOfSeq: 4 });
    expect(trayAt4.map((v) => v.versionId)).toEqual(['a1', 'a2']);
  });

  it('computeCostLedger respects asOfSeq', () => {
    const ledgerAt2 = computeCostLedger(EVENTS, { asOfSeq: 2 });
    expect(ledgerAt2.totalUsd).toBeCloseTo(0.30); // 0.10 + 0.20
    const ledgerAt4 = computeCostLedger(EVENTS, { asOfSeq: 4 });
    expect(ledgerAt4.totalUsd).toBeCloseTo(0.45); // 0.10 + 0.20 + 0.15
  });
});
