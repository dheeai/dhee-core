/**
 * EventLog — append-only JSONL event log per project.
 *
 * Failure modes (Red first; each test enumerates one):
 *   1. Append to a fresh project creates `.dhee/events.jsonl` and
 *      assigns `seq: 1, id, ts`.
 *   2. Append assigns monotonically increasing `seq` across appends.
 *   3. Read filters by `branchId` and `sinceSeq`.
 *   4. Torn last line (truncated mid-write) is dropped silently on read.
 *   5. Empty file returns empty iterator.
 *   6. Missing `.dhee` dir is auto-created on first append.
 *   7. Two appends within the same ms get distinct `seq` and `id`.
 *   8. JSON Parse error on a middle line: skip + continue with the rest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEventLog } from '../../../src/dag/eventLog/EventLog.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'eventlog-test-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('EventLog — append + read', () => {
  it('first append assigns seq=1, generates id+ts, creates .dhee/events.jsonl', () => {
    const log = openEventLog(projectDir);
    const event = log.append({
      branchId: 'main',
      actor: 'walker',
      kind: 'project.created',
      payload: { projectDir },
    });

    expect(event.seq).toBe(1);
    expect(event.id).toMatch(/.+/);
    expect(typeof event.ts).toBe('number');
    expect(event.kind).toBe('project.created');

    const filePath = join(projectDir, '.dhee', 'events.jsonl');
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf-8').trim();
    expect(raw.split('\n')).toHaveLength(1);
    const parsed = JSON.parse(raw) as { seq: number; kind: string };
    expect(parsed.seq).toBe(1);
    expect(parsed.kind).toBe('project.created');
  });

  it('assigns monotonically increasing seq across N appends', () => {
    const log = openEventLog(projectDir);
    for (let i = 0; i < 5; i++) {
      const e = log.append({
        branchId: 'main',
        actor: 'walker',
        kind: 'node.started',
        payload: { nodeId: `n${i}` },
      });
      expect(e.seq).toBe(i + 1);
    }

    const events = [...log.read()];
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('read filters by branchId', () => {
    const log = openEventLog(projectDir);
    log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    log.append({ branchId: 'feature-x', actor: 'walker', kind: 'node.started', payload: { nodeId: 'b' } });
    log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'c' } });

    const main = [...log.read({ branchId: 'main' })];
    expect(main.map((e) => (e.payload as { nodeId: string }).nodeId)).toEqual(['a', 'c']);

    const feature = [...log.read({ branchId: 'feature-x' })];
    expect(feature.map((e) => (e.payload as { nodeId: string }).nodeId)).toEqual(['b']);
  });

  it('read filters by sinceSeq (exclusive)', () => {
    const log = openEventLog(projectDir);
    for (let i = 0; i < 5; i++) {
      log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: `n${i}` } });
    }
    const after = [...log.read({ sinceSeq: 2 })];
    expect(after.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('torn last line is silently dropped on read', () => {
    const log = openEventLog(projectDir);
    log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'b' } });

    // Append a torn line (no closing brace, no newline).
    appendFileSync(join(projectDir, '.dhee', 'events.jsonl'), '{"seq":3,"kind":"node.start');

    const events = [...log.read()];
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('empty file returns empty iterator', () => {
    const log = openEventLog(projectDir);
    expect([...log.read()]).toEqual([]);
  });

  it('missing .dhee directory is auto-created on first append', () => {
    expect(existsSync(join(projectDir, '.dhee'))).toBe(false);
    const log = openEventLog(projectDir);
    log.append({ branchId: 'main', actor: 'walker', kind: 'project.created', payload: { projectDir } });
    expect(existsSync(join(projectDir, '.dhee'))).toBe(true);
  });

  it('two appends within the same ms get distinct seq and id', () => {
    const log = openEventLog(projectDir);
    const e1 = log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    const e2 = log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'b' } });
    // Note: ts may collide on fast systems; what MUST be distinct is seq and id.
    expect(e1.seq).not.toBe(e2.seq);
    expect(e1.id).not.toBe(e2.id);
  });

  it('JSON parse error on a middle line is skipped; surrounding events parse fine', () => {
    const log = openEventLog(projectDir);
    log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    // Inject a malformed line by writing directly.
    const filePath = join(projectDir, '.dhee', 'events.jsonl');
    appendFileSync(filePath, 'this is not json at all\n');
    log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'b' } });

    const events = [...log.read()];
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { nodeId: string }).nodeId)).toEqual(['a', 'b']);
  });

  it('parentEventId is preserved on append', () => {
    const log = openEventLog(projectDir);
    const parent = log.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    const child = log.append({
      branchId: 'main',
      actor: 'walker',
      kind: 'node.completed',
      payload: { nodeId: 'a' },
      parentEventId: parent.id,
    });
    expect(child.parentEventId).toBe(parent.id);
  });

  it('append is durable: a fresh log handle on the same dir reads prior events', () => {
    const log1 = openEventLog(projectDir);
    log1.append({ branchId: 'main', actor: 'walker', kind: 'node.started', payload: { nodeId: 'a' } });
    log1.append({ branchId: 'main', actor: 'walker', kind: 'node.completed', payload: { nodeId: 'a' } });

    const log2 = openEventLog(projectDir);
    const events = [...log2.read()];
    expect(events).toHaveLength(2);
    expect(log2.nextSeq()).toBe(3);
  });
});
