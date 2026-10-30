import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEventLog } from '../../../src/dag/eventLog/EventLog.js';
import {
  acquireWalkLock,
  isWalkLockResult,
  isWalkLocked,
} from '../../../src/dag/projectWalkLock.js';
import {
  readProductionReview,
  recordProductionReview,
} from '../../../src/dag/productionReviews.js';

let projectDir: string;
const scope = { gate: 'storyboard', targets: [{ nodeId: 'story' }] };
function complete(
  nodeId: string,
  versionId = 'v1',
  branchId = 'main',
  dependencies: { nodeId: string }[] = []
) {
  const outputPath = `${nodeId}-${versionId}.txt`;
  writeFileSync(join(projectDir, outputPath), `${nodeId} ${versionId}`);
  openEventLog(projectDir).append({
    kind: 'node.completed',
    actor: 'walker',
    branchId,
    payload: { nodeId, versionId, outputPath, dependencies },
  });
}
async function approve() {
  const review = await readProductionReview({ projectDir, ...scope });
  return recordProductionReview({
    projectDir,
    ...scope,
    expectedFingerprint: review.fingerprint!,
    decision: 'approved',
  });
}
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dhee-review-'));
  writeFileSync(join(projectDir, 'project.json'), '{}');
  complete('story');
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe('version-bound production review records', () => {
  it('persists a decision and restores it from the event log', async () => {
    expect((await approve()).status).toBe('approved');
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('approved');
    expect([...openEventLog(projectDir).read()].at(-1)?.kind).toBe('review.decided');
  });
  it('makes edits to bytes stale even without a version event', async () => {
    await approve();
    writeFileSync(join(projectDir, 'story-v1.txt'), 'edited');
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('stale');
  });
  it('tracks the selected historical version', async () => {
    complete('story', 'v2');
    await approve();
    openEventLog(projectDir).append({
      kind: 'version.selected',
      actor: 'user',
      branchId: 'main',
      payload: { nodeId: 'story', versionId: 'v1' },
    });
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('stale');
  });
  it('includes transitive dependency content without staling unrelated approvals', async () => {
    complete('brief');
    complete('story', 'v2', 'main', [{ nodeId: 'brief' }]);
    await approve();
    complete('unrelated');
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('approved');
    writeFileSync(join(projectDir, 'brief-v1.txt'), 'changed brief');
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('stale');
  });
  it('rejects a stale save instead of approving unseen content', async () => {
    const before = await readProductionReview({ projectDir, ...scope });
    complete('story', 'v2');
    await expect(
      recordProductionReview({
        projectDir,
        ...scope,
        expectedFingerprint: before.fingerprint!,
        decision: 'approved',
      })
    ).rejects.toThrow(/changed/i);
  });
  it('does not approve missing or failed outputs or an empty scope', async () => {
    rmSync(join(projectDir, 'story-v1.txt'));
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('unavailable');
    complete('story');
    openEventLog(projectDir).append({
      kind: 'node.failed',
      actor: 'walker',
      branchId: 'main',
      payload: { nodeId: 'story', error: 'failure' },
    });
    await expect(approve()).rejects.toThrow();
    await expect(
      readProductionReview({ projectDir, gate: 'storyboard', targets: [] })
    ).rejects.toThrow(/targets/i);
  });
  it('rejects recording while a walker holds the project lock', async () => {
    const lock = acquireWalkLock(projectDir);
    if (isWalkLockResult(lock)) throw new Error('unexpected lock');
    try {
      await expect(approve()).rejects.toThrow(/in progress/i);
    } finally {
      lock.release();
    }
  });
  it('supports changes requested and never reuses another gate or branch decision', async () => {
    const approved = await approve();
    expect((await readProductionReview({ projectDir, ...scope, gate: 'rough-cut' })).status).toBe(
      'unreviewed'
    );
    complete('story', 'v1', 'other');
    expect((await readProductionReview({ projectDir, ...scope, branchId: 'other' })).status).toBe(
      'unreviewed'
    );
    await recordProductionReview({
      projectDir,
      ...scope,
      expectedFingerprint: approved.fingerprint!,
      decision: 'changes-requested',
      notes: 'Revise the ending',
    });
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('changes-requested');
  });
  it('uses one lock for a project and its symlink alias and releases after rejection', async () => {
    const alias = `${projectDir}-alias`;
    symlinkSync(projectDir, alias, 'dir');
    const lock = acquireWalkLock(alias);
    if (isWalkLockResult(lock)) throw new Error('unexpected lock');
    try {
      expect(isWalkLocked(realpathSync(projectDir))).toBe(true);
      await expect(approve()).rejects.toThrow(/in progress/i);
    } finally {
      lock.release();
      rmSync(alias);
    }
    expect(isWalkLocked(projectDir)).toBe(false);
    expect((await approve()).status).toBe('approved');
  });
  it('refuses a missing dependency and symlinked artifacts outside the project', async () => {
    complete('story', 'v2', 'main', [{ nodeId: 'missing' }]);
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('unavailable');
    complete('story', 'v3');
    rmSync(join(projectDir, 'story-v3.txt'));
    symlinkSync(join(projectDir, '..'), join(projectDir, 'story-v3.txt'));
    expect((await readProductionReview({ projectDir, ...scope })).status).toBe('unavailable');
  });
  it('releases the review lock after a stale save fails', async () => {
    await expect(
      recordProductionReview({
        projectDir,
        ...scope,
        expectedFingerprint: '0'.repeat(64),
        decision: 'approved',
      })
    ).rejects.toThrow(/changed/);
    expect(isWalkLocked(projectDir)).toBe(false);
    expect((await approve()).status).toBe('approved');
  });
  it('freezes the bytes displayed for approval and refreshes to a new preview after edits', async () => {
    const before = await readProductionReview({ projectDir, ...scope });
    const oldPath = (before as any).previews?.[0]?.previewPath;
    expect(oldPath).toBeTruthy();
    expect(readFileSync(join(projectDir, oldPath), 'utf8')).toBe('story v1');
    writeFileSync(join(projectDir, 'story-v1.txt'), 'new screenplay');
    const after = await readProductionReview({ projectDir, ...scope });
    const newPath = (after as any).previews?.[0]?.previewPath;
    expect(newPath).not.toBe(oldPath);
    expect(readFileSync(join(projectDir, oldPath), 'utf8')).toBe('story v1');
    expect(readFileSync(join(projectDir, newPath), 'utf8')).toBe('new screenplay');
    await expect(
      recordProductionReview({
        projectDir,
        ...scope,
        decision: 'approved',
        expectedFingerprint: before.fingerprint!,
      })
    ).rejects.toThrow(/changed/);
    expect(
      (
        await recordProductionReview({
          projectDir,
          ...scope,
          decision: 'approved',
          expectedFingerprint: after.fingerprint!,
        })
      ).status
    ).toBe('approved');
  });
});
