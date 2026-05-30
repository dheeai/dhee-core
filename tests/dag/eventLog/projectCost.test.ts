/**
 * projectCost — cost ledger from generation events.
 *
 *   1. No events → zero cost, zero count.
 *   2. node.completed with costUsd → accumulates.
 *   3. cached:true does not add to costUsd but counts as cacheHits.
 *   4. Per-branch totals are isolated.
 */
import { describe, it, expect } from 'vitest';
import type { DheeEvent } from '../../../src/dag/eventLog/events.js';
import { computeCostLedger } from '../../../src/dag/eventLog/projectCost.js';

function mkEvent(seq: number, payload: Record<string, unknown>, branchId = 'main'): DheeEvent {
  return {
    seq,
    id: `e${seq}`,
    ts: seq,
    branchId,
    actor: 'runner',
    kind: 'node.completed',
    payload,
  } as unknown as DheeEvent;
}

describe('projectCost / computeCostLedger', () => {
  it('no events → zero everything', () => {
    const c = computeCostLedger([]);
    expect(c.totalUsd).toBe(0);
    expect(c.computeCount).toBe(0);
    expect(c.cacheHits).toBe(0);
  });

  it('costUsd sums across events', () => {
    const evs = [
      mkEvent(1, { nodeId: 'a', versionId: 'v1', outputPath: 'a', generation: { tool: 'llm.generate', toolVersion: '0.1.0', cached: false, costUsd: 0.01 } }),
      mkEvent(2, { nodeId: 'b', versionId: 'v1', outputPath: 'b', generation: { tool: 'comfy.image', toolVersion: '0.1.0', cached: false, costUsd: 0.02 } }),
    ];
    const c = computeCostLedger(evs);
    expect(c.totalUsd).toBeCloseTo(0.03);
    expect(c.computeCount).toBe(2);
    expect(c.cacheHits).toBe(0);
  });

  it('cached events do not add to cost but count as cache hits', () => {
    const evs = [
      mkEvent(1, { nodeId: 'a', versionId: 'v1', outputPath: 'a', generation: { tool: 'comfy.image', toolVersion: '0.1.0', cached: true, costUsd: 0 } }),
      mkEvent(2, { nodeId: 'b', versionId: 'v1', outputPath: 'b', generation: { tool: 'comfy.image', toolVersion: '0.1.0', cached: false, costUsd: 0.02 } }),
    ];
    const c = computeCostLedger(evs);
    expect(c.totalUsd).toBeCloseTo(0.02);
    expect(c.cacheHits).toBe(1);
    expect(c.computeCount).toBe(2);
  });

  it('per-branch isolation', () => {
    const evs = [
      mkEvent(1, { nodeId: 'a', versionId: 'v1', outputPath: 'a', generation: { tool: 'x', toolVersion: '0.1.0', cached: false, costUsd: 0.10 } }),
      mkEvent(2, { nodeId: 'b', versionId: 'v1', outputPath: 'b', generation: { tool: 'x', toolVersion: '0.1.0', cached: false, costUsd: 0.25 } }, 'feature'),
    ];
    const main = computeCostLedger(evs, { branchId: 'main' });
    const feature = computeCostLedger(evs, { branchId: 'feature' });
    expect(main.totalUsd).toBeCloseTo(0.10);
    expect(feature.totalUsd).toBeCloseTo(0.25);
  });
});
