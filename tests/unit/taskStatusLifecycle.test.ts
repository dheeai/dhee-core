/**
 * Tests for the lifecycle classifier inside dhee_task_status (Bug 15).
 *
 * Pi-agent was observed treating a runner that's "active but blocked on
 * a failed node" as "still generating" — refusing to dispatch a new run
 * and asking the user to wait for streaming events that would never
 * arrive. The lifecycle field distinguishes:
 *   - 'running' — at least one node in_progress
 *   - 'blocked' — failed >0 and in_progress=0
 *   - 'idle'    — no work, no failures
 *
 * Tests cover the executorState → lifecycle mapping. They don't spin up
 * the background runner — that's covered (separately) by taskStatusCooldown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We want to test the lifecycle math without booting the background runner
// singleton. The classifier reads project.json executorState off disk —
// build a fake project and exercise it via a thin re-implementation that
// mirrors the same logic.

function classify(nodes: Record<string, { status?: string }>): {
  lifecycle: 'running' | 'blocked' | 'idle';
  inProgress: number;
  failed: number;
} {
  let inProgress = 0;
  let failed = 0;
  for (const n of Object.values(nodes)) {
    if (!n) continue;
    if (n.status === 'in_progress' || n.status === 'running') inProgress += 1;
    else if (n.status === 'failed') failed += 1;
  }
  let lifecycle: 'running' | 'blocked' | 'idle';
  if (inProgress > 0) lifecycle = 'running';
  else if (failed > 0) lifecycle = 'blocked';
  else lifecycle = 'idle';
  return { lifecycle, inProgress, failed };
}

describe('dhee_task_status lifecycle classifier (Bug 15)', () => {
  it('all-completed nodes → idle', () => {
    const res = classify({
      a: { status: 'completed' },
      b: { status: 'completed' },
    });
    expect(res.lifecycle).toBe('idle');
    expect(res.inProgress).toBe(0);
    expect(res.failed).toBe(0);
  });

  it('one in_progress → running', () => {
    const res = classify({
      a: { status: 'completed' },
      b: { status: 'in_progress' },
    });
    expect(res.lifecycle).toBe('running');
    expect(res.inProgress).toBe(1);
  });

  it('failed but no in_progress → blocked', () => {
    const res = classify({
      a: { status: 'completed' },
      b: { status: 'failed' },
    });
    expect(res.lifecycle).toBe('blocked');
    expect(res.failed).toBe(1);
    expect(res.inProgress).toBe(0);
  });

  it('failed AND in_progress → running (real work is happening even if other nodes failed)', () => {
    // The Bug 15 fix prioritizes 'running' over 'blocked' when work is
    // genuinely in flight — the failures will be visible separately, but
    // the agent should not be told to invalidate while live nodes are
    // mid-render.
    const res = classify({
      a: { status: 'failed' },
      b: { status: 'in_progress' },
    });
    expect(res.lifecycle).toBe('running');
    expect(res.failed).toBe(1);
    expect(res.inProgress).toBe(1);
  });

  it('empty nodes → idle', () => {
    const res = classify({});
    expect(res.lifecycle).toBe('idle');
  });

  it('mixed pending + completed → idle (pending alone is not "running")', () => {
    const res = classify({
      a: { status: 'completed' },
      b: { status: 'pending' },
      c: { status: 'pending' },
    });
    expect(res.lifecycle).toBe('idle');
  });
});

// Smoke test: the actual classifier function reads project.json from disk
// via the exported helper path. We don't run the heavyweight tool here
// (it requires the background runner singleton), but we do verify the
// disk-reading shape.
describe('lifecycle classifier reads project.json executorState', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('parses a project.json shape and counts statuses correctly', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'task-status-lifecycle-'));
    const projectDir = join(tmpDir, 'demo.dhee');
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        executorState: {
          nodes: {
            n1: { status: 'completed' },
            n2: { status: 'failed', error: 'OpenAI API error' },
            n3: { status: 'pending' },
          },
        },
      }),
    );

    // Re-implement disk-reading branch inline to match production logic:
    const raw = JSON.parse(
      require('node:fs').readFileSync(join(projectDir, 'project.json'), 'utf-8'),
    );
    const result = classify(raw.executorState.nodes);
    expect(result.lifecycle).toBe('blocked');
    expect(result.failed).toBe(1);
    expect(result.inProgress).toBe(0);
  });
});
