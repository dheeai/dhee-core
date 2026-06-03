/**
 * EventLog seq integrity across multiple handles.
 *
 * Regression for the 2026-06-03 duplicate-seq corruption: the old
 * EventLog cached `nextSeq` per handle and incremented it in memory, so
 * two live handles on one project (two concurrent walks) each handed out
 * the SAME seq — e.g. two events at seq 306. The fix re-derives nextSeq
 * from disk on every append.
 *
 * This test exercises the real behavior: open TWO independent handles on
 * one project and interleave appends, then assert seqs are unique and
 * strictly monotonic. Under the old cached implementation this fails
 * (duplicates); under the fix it passes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';

describe('EventLog seq integrity across handles', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'evlog-seq-test-'));
    dirs.push(d);
    return d;
  }

  function started(nodeId: string) {
    return { branchId: 'main', actor: 'walker' as const, kind: 'node.started' as const, payload: { nodeId } };
  }

  it('two interleaved handles never reuse a seq', () => {
    const dir = tmp();
    const a = openEventLog(dir);
    const b = openEventLog(dir);

    // Interleave appends between the two handles — the exact shape that
    // produced duplicate seq 306 in the field.
    const events = [
      a.append(started('n1')),
      b.append(started('n2')),
      a.append(started('n3')),
      b.append(started('n4')),
      a.append(started('n5')),
      b.append(started('n6')),
    ];

    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // all unique
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]); // strictly monotonic from 1
  });

  it('a freshly opened handle continues the on-disk seq, not from 1', () => {
    const dir = tmp();
    const a = openEventLog(dir);
    a.append(started('n1'));
    a.append(started('n2'));

    // A second handle opened after writes must see seq 3 next, not 1.
    const b = openEventLog(dir);
    const e = b.append(started('n3'));
    expect(e.seq).toBe(3);
    expect(b.nextSeq()).toBe(4);
  });

  it('the persisted log has no duplicate seqs after interleaving', () => {
    const dir = tmp();
    const a = openEventLog(dir);
    const b = openEventLog(dir);
    for (let i = 0; i < 10; i++) {
      (i % 2 === 0 ? a : b).append(started(`n${i}`));
    }
    const onDisk = [...a.read()].map((e) => e.seq);
    expect(new Set(onDisk).size).toBe(onDisk.length);
    expect(onDisk).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
