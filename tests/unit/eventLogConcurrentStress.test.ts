/**
 * EventLog concurrency STRESS + cost-rollup integrity.
 *
 * Extends eventLogConcurrentSeq.test.ts (which interleaves 6 appends
 * across 2 handles) in the ways the coverage review flagged as missing:
 *
 *   1. SCALE — many handles, hundreds of round-robin appends, asserting
 *      the on-disk log stays unique + strictly monotonic. This is the
 *      "two concurrent walks of one project" shape at realistic volume.
 *   2. COST ROLLUP over a concurrently-built log — interleave cached and
 *      paid completions across handles and assert computeCostLedger sums
 *      exactly right (the review called out cost-under-cache/retry as an
 *      untested cost-accounting risk).
 *   3. TORN/MALFORMED line tolerance in SEQ DERIVATION (not just read) —
 *      a half-written final line must not corrupt the next seq.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import { computeCostLedger } from '../../src/dag/eventLog/projectCost.js';
import { eventLogPath, dheeDir } from '../../src/dag/eventLog/eventLogPath.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'evlog-stress-'));
  dirs.push(d);
  return d;
}

function started(nodeId: string) {
  return { branchId: 'main', actor: 'walker' as const, kind: 'node.started' as const, payload: { nodeId } };
}

function completed(nodeId: string, gen: { costUsd?: number; cached: boolean }) {
  return {
    branchId: 'main',
    actor: 'walker' as const,
    kind: 'node.completed' as const,
    payload: {
      nodeId,
      versionId: 'v1',
      outputPath: `out/${nodeId}.png`,
      generation: { tool: 'comfy.tti', toolVersion: '1.0.0', ...gen },
    },
  };
}

describe('EventLog concurrency stress', () => {
  it('5 handles × 200 round-robin appends → unique, strictly monotonic 1..1000', () => {
    const dir = tmp();
    const handles = Array.from({ length: 5 }, () => openEventLog(dir));
    const total = 1000;
    for (let i = 0; i < total; i++) {
      handles[i % handles.length]!.append(started(`n${i}`));
    }
    const onDisk = [...handles[0]!.read()].map((e) => e.seq);
    expect(onDisk).toHaveLength(total);
    expect(new Set(onDisk).size).toBe(total); // no duplicates
    expect(onDisk[0]).toBe(1);
    expect(onDisk[total - 1]).toBe(total);
    // strictly monotonic
    for (let i = 1; i < onDisk.length; i++) {
      expect(onDisk[i]!).toBe(onDisk[i - 1]! + 1);
    }
  });
});

describe('cost ledger over a concurrently-built log', () => {
  it('sums paid completions, counts cache hits, and tallies savings exactly', () => {
    const dir = tmp();
    const a = openEventLog(dir);
    const b = openEventLog(dir);

    // Interleave across two handles: 3 paid (0.10, 0.20, 0.05) and 2
    // cached (would have cost 0.10 and 0.07 → counted as savings).
    a.append(completed('shot_1', { costUsd: 0.1, cached: false }));
    b.append(completed('shot_2', { costUsd: 0.1, cached: true }));
    a.append(completed('shot_3', { costUsd: 0.2, cached: false }));
    b.append(completed('shot_4', { costUsd: 0.07, cached: true }));
    a.append(completed('shot_5', { costUsd: 0.05, cached: false }));

    const ledger = computeCostLedger([...a.read()]);
    expect(ledger.computeCount).toBe(5);
    expect(ledger.cacheHits).toBe(2);
    expect(ledger.totalUsd).toBeCloseTo(0.35, 10); // 0.10 + 0.20 + 0.05
    expect(ledger.estimatedSavingsUsd).toBeCloseTo(0.17, 10); // 0.10 + 0.07
  });

  it('a cache HIT never adds to totalUsd (the credit-burn invariant)', () => {
    const dir = tmp();
    const log = openEventLog(dir);
    // Same node regenerated: first paid, then served from cache.
    log.append(completed('story', { costUsd: 0.5, cached: false }));
    log.append(completed('story', { costUsd: 0.5, cached: true }));
    const ledger = computeCostLedger([...log.read()]);
    expect(ledger.totalUsd).toBeCloseTo(0.5, 10); // NOT 1.0 — the cached retry is free
    expect(ledger.cacheHits).toBe(1);
  });
});

describe('seq derivation + append heal a torn final line', () => {
  // EXPECTED TO FAIL until pass 2. A crash mid-write can leave a final
  // line with no trailing newline. seq derivation already tolerates this
  // (the torn line is unparseable, so it doesn't count) — but `append`
  // currently writes straight onto the end of the file, CONCATENATING the
  // new event onto the torn fragment and corrupting BOTH lines. The fix:
  // append must ensure the file ends with a newline before writing.
  it('a truncated last line does not corrupt the next assigned seq', () => {
    const dir = tmp();
    const log = openEventLog(dir);
    log.append(started('n1')); // seq 1
    log.append(started('n2')); // seq 2

    // Simulate a crash mid-write: a half-written (un-newlined, non-JSON)
    // fragment at the end of the file.
    mkdirSync(dheeDir(dir), { recursive: true });
    appendFileSync(eventLogPath(dir), '{"seq":3,"kind":"node.started","pay');

    // seq derivation is robust: the torn fragment is unparseable, so the
    // next seq is still 3. (This assertion passes today.)
    const fresh = openEventLog(dir);
    const e = fresh.append(started('n3'));
    expect(e.seq).toBe(3);

    // The new event must land on its OWN line, not concatenated onto the
    // torn fragment — so read yields the three intact events. (Fails today:
    // append doesn't heal the missing newline first.)
    const seqs = [...fresh.read()].map((x) => x.seq).sort((a, c) => a - c);
    expect(seqs).toEqual([1, 2, 3]);
  });
});
