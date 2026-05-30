/**
 * projectWalkState — pure fold from event log to the legacy WalkState
 * shape. Failure modes:
 *
 *   1. Empty event list → empty WalkState.
 *   2. project.created + bundle.bound seeds bundleSource/Version/engineVersion.
 *   3. node.started → in_progress entry with startedAt.
 *   4. node.completed → completed entry with outputPath, versions[], selectedVersionId.
 *   5. node.failed → failed entry with error.
 *   6. node.invalidated → entry is removed; nodeId added to lastInvalidatedIds.
 *   7. itemId-scoped events use `nodeId:itemId` key.
 *   8. version.added appears as a new entry in versions[] (latest auto-selected).
 *   9. version.selected flips selectedVersionId; versions[] unchanged.
 *  10. Events on a non-default branchId are excluded from main projection.
 *  11. Events on a non-default branchId are INCLUDED when projecting that branch.
 *  12. Re-fold yields the same projection (deterministic).
 */
import { describe, it, expect } from 'vitest';
import type { DheeEvent } from '../../../src/dag/eventLog/events.js';
import { projectWalkState } from '../../../src/dag/eventLog/projectWalkState.js';

function mkEvent<K extends DheeEvent['kind']>(
  seq: number,
  kind: K,
  payload: Record<string, unknown>,
  opts: { branchId?: string; itemId?: string; actor?: DheeEvent['actor'] } = {},
): DheeEvent {
  return {
    seq,
    id: `e${seq}`,
    ts: 1_700_000_000_000 + seq,
    branchId: opts.branchId ?? 'main',
    actor: opts.actor ?? 'walker',
    kind,
    payload,
  } as unknown as DheeEvent;
}

describe('projectWalkState', () => {
  it('empty event list → empty WalkState shape', () => {
    const w = projectWalkState([]);
    expect(w.nodes).toEqual({});
    expect(w.lastInvalidatedIds).toEqual([]);
    expect(w.bundleSource).toBe('');
    expect(w.bundleVersion).toBe('');
    expect(w.engineVersion).toBe('');
  });

  it('bundle.bound seeds bundleSource/Version/engineVersion', () => {
    const w = projectWalkState([
      mkEvent(1, 'bundle.bound', {
        bundleSource: 'built-in:tiny',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
      }),
    ]);
    expect(w.bundleSource).toBe('built-in:tiny');
    expect(w.bundleVersion).toBe('0.1.0');
    expect(w.engineVersion).toBe('0.1.0');
  });

  it('node.started → in_progress entry with startedAt', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.started', { nodeId: 'a' }),
    ]);
    expect(w.nodes['a']?.status).toBe('in_progress');
    expect(typeof w.nodes['a']?.startedAt).toBe('number');
  });

  it('node.completed → completed entry with outputPath, versions[], selectedVersionId', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.started', { nodeId: 'a' }),
      mkEvent(2, 'node.completed', {
        nodeId: 'a',
        versionId: 'v1',
        outputPath: 'out/a.md',
        artifact: { format: 'md', bytes: 42 },
      }),
    ]);
    expect(w.nodes['a']?.status).toBe('completed');
    expect(w.nodes['a']?.outputPath).toBe('out/a.md');
    expect(w.nodes['a']?.versions?.length).toBe(1);
    expect(w.nodes['a']?.selectedVersionId).toBe('v1');
  });

  it('node.failed → failed entry with error', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.started', { nodeId: 'a' }),
      mkEvent(2, 'node.failed', { nodeId: 'a', error: 'boom' }),
    ]);
    expect(w.nodes['a']?.status).toBe('failed');
    expect(w.nodes['a']?.error).toBe('boom');
  });

  it('node.invalidated removes the entry and tracks lastInvalidatedIds', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.completed', {
        nodeId: 'a',
        versionId: 'v1',
        outputPath: 'out/a.md',
      }),
      mkEvent(2, 'node.invalidated', { nodeId: 'a' }),
    ]);
    expect(w.nodes['a']).toBeUndefined();
    expect(w.lastInvalidatedIds).toContain('a');
  });

  it('itemId-scoped events use `nodeId:itemId` key', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.completed', {
        nodeId: 'shot_image',
        itemId: 'scene_1_shot_3',
        versionId: 'v1',
        outputPath: 'out/scene_1_shot_3.png',
      }),
    ]);
    expect(w.nodes['shot_image:scene_1_shot_3']?.status).toBe('completed');
  });

  it('two node.completed for same node produce two versions; latest auto-selected', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.completed', {
        nodeId: 'a',
        versionId: 'v1',
        outputPath: 'out/a.v1.md',
      }),
      mkEvent(2, 'node.invalidated', { nodeId: 'a' }),
      mkEvent(3, 'node.completed', {
        nodeId: 'a',
        versionId: 'v2',
        outputPath: 'out/a.v2.md',
      }),
    ]);
    expect(w.nodes['a']?.versions?.length).toBe(2);
    expect(w.nodes['a']?.selectedVersionId).toBe('v2');
    expect(w.nodes['a']?.outputPath).toBe('out/a.v2.md');
  });

  it('version.selected flips selectedVersionId without losing other versions', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.completed', {
        nodeId: 'a',
        versionId: 'v1',
        outputPath: 'out/a.v1.md',
      }),
      mkEvent(2, 'node.invalidated', { nodeId: 'a' }),
      mkEvent(3, 'node.completed', {
        nodeId: 'a',
        versionId: 'v2',
        outputPath: 'out/a.v2.md',
      }),
      mkEvent(4, 'version.selected', { nodeId: 'a', versionId: 'v1' }),
    ]);
    expect(w.nodes['a']?.versions?.length).toBe(2);
    expect(w.nodes['a']?.selectedVersionId).toBe('v1');
    expect(w.nodes['a']?.outputPath).toBe('out/a.v1.md');
  });

  it('events on a non-default branch are excluded from the main projection', () => {
    const w = projectWalkState([
      mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' }),
      mkEvent(2, 'node.completed', { nodeId: 'b', versionId: 'v1', outputPath: 'out/b.md' }, { branchId: 'feature' }),
    ]);
    expect(w.nodes['a']?.status).toBe('completed');
    expect(w.nodes['b']).toBeUndefined();
  });

  it('events on a non-default branch are included when projecting that branch', () => {
    const w = projectWalkState(
      [
        mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' }),
        mkEvent(2, 'node.completed', { nodeId: 'b', versionId: 'v1', outputPath: 'out/b.md' }, { branchId: 'feature' }),
      ],
      { branchId: 'feature' },
    );
    expect(w.nodes['b']?.status).toBe('completed');
  });

  it('re-fold is deterministic — same events → same projection', () => {
    const events = [
      mkEvent(1, 'node.started', { nodeId: 'a' }),
      mkEvent(2, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' }),
      mkEvent(3, 'node.started', { nodeId: 'b' }),
      mkEvent(4, 'node.failed', { nodeId: 'b', error: 'oops' }),
    ];
    const a = projectWalkState(events);
    const b = projectWalkState(events);
    expect(a).toEqual(b);
  });
});
