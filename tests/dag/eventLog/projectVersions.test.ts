/**
 * projectVersions — list candidate versions for a node instance.
 *
 *   1. No events → empty tray.
 *   2. One completion → one version, selected.
 *   3. Two completions on same node → two versions; latest selected.
 *   4. version.selected after two completions → reflects the choice.
 *   5. itemId scoping: same node, two items → two separate trays.
 *   6. branchId scoping: versions on a branch are NOT in the main tray.
 */
import { describe, it, expect } from 'vitest';
import type { DheeEvent } from '../../../src/dag/eventLog/events.js';
import { listVersions } from '../../../src/dag/eventLog/projectVersions.js';

function mkEvent(seq: number, kind: DheeEvent['kind'], payload: Record<string, unknown>, branchId = 'main'): DheeEvent {
  return { seq, id: `e${seq}`, ts: seq, branchId, actor: 'walker', kind, payload } as unknown as DheeEvent;
}

describe('projectVersions / listVersions', () => {
  it('no events → empty tray', () => {
    expect(listVersions([], 'a')).toEqual([]);
  });

  it('one completion → one version, selected', () => {
    const evs = [mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' })];
    const tray = listVersions(evs, 'a');
    expect(tray).toHaveLength(1);
    expect(tray[0]?.versionId).toBe('v1');
    expect(tray[0]?.selected).toBe(true);
  });

  it('two completions on same node → two versions; latest selected', () => {
    const evs = [
      mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.v1.md' }),
      mkEvent(2, 'node.invalidated', { nodeId: 'a' }),
      mkEvent(3, 'node.completed', { nodeId: 'a', versionId: 'v2', outputPath: 'out/a.v2.md' }),
    ];
    const tray = listVersions(evs, 'a');
    expect(tray.map((v) => v.versionId)).toEqual(['v1', 'v2']);
    expect(tray.find((v) => v.selected)?.versionId).toBe('v2');
  });

  it('version.selected flips the selection', () => {
    const evs = [
      mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.v1.md' }),
      mkEvent(2, 'node.invalidated', { nodeId: 'a' }),
      mkEvent(3, 'node.completed', { nodeId: 'a', versionId: 'v2', outputPath: 'out/a.v2.md' }),
      mkEvent(4, 'version.selected', { nodeId: 'a', versionId: 'v1' }),
    ];
    const tray = listVersions(evs, 'a');
    expect(tray.find((v) => v.selected)?.versionId).toBe('v1');
  });

  it('itemId scopes the tray', () => {
    const evs = [
      mkEvent(1, 'node.completed', { nodeId: 'shot_image', itemId: 'shot_1', versionId: 'v1', outputPath: 'out/1.png' }),
      mkEvent(2, 'node.completed', { nodeId: 'shot_image', itemId: 'shot_2', versionId: 'v1', outputPath: 'out/2.png' }),
    ];
    expect(listVersions(evs, 'shot_image', 'shot_1')).toHaveLength(1);
    expect(listVersions(evs, 'shot_image', 'shot_2')).toHaveLength(1);
    expect(listVersions(evs, 'shot_image')).toHaveLength(0);
  });

  it('branch isolation: main projection does not see branch versions', () => {
    const evs = [
      mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' }),
      mkEvent(2, 'node.completed', { nodeId: 'a', versionId: 'v2', outputPath: 'out/a.v2.md' }, 'feature'),
    ];
    const main = listVersions(evs, 'a', undefined, { branchId: 'main' });
    const feature = listVersions(evs, 'a', undefined, { branchId: 'feature' });
    expect(main.map((v) => v.versionId)).toEqual(['v1']);
    expect(feature.map((v) => v.versionId)).toEqual(['v2']);
  });
});
