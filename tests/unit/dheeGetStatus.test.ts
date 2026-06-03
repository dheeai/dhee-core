/**
 * dhee_get_status — liveness reconciliation.
 *
 * walkState `in_progress` is NOT proof a run is live. A node left
 * `in_progress` by a killed/crashed run dangles forever; reading
 * walkState alone makes the agent report "still running" and refuse to
 * resume. The tool must consult the actual run state (BackgroundTaskRunner)
 * and call a dangling entry INTERRUPTED, steering the agent to resume.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeGetStatusTool,
  __resetGetStatusCacheForTesting,
  type ActiveRunProbe,
} from '../../src/agent/pi/tools/dheeGetStatus.js';

interface ToolLike {
  execute: (id: string, params: { projectDir: string }) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const dirs: string[] = [];
function projectWith(nodes: Record<string, { status: string; startedAt?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'getstatus-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ walkState: { nodes } }), 'utf8');
  return dir;
}
function tool(probe: () => Promise<ActiveRunProbe>): ToolLike {
  return makeGetStatusTool({ probeActiveRun: probe }) as unknown as ToolLike;
}

beforeEach(() => __resetGetStatusCacheForTesting());
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('dhee_get_status liveness reconciliation', () => {
  it('reports a dangling in_progress as INTERRUPTED when NO run is active', async () => {
    const dir = projectWith({
      plot: { status: 'completed' },
      'scene_clip:scene_3_chunk_2': { status: 'in_progress', startedAt: Date.now() - 26 * 60_000 },
    });
    const r = await tool(async () => ({ known: true })).execute('t', { projectDir: dir });
    const text = r.content[0]!.text;
    expect(text).toMatch(/interrupted/i);
    expect(text).toMatch(/NOT running|not.*active/i);
    expect(text).toMatch(/dhee_start_run|dhee_run_bundle|dispatch a run/i);
    // It must NOT frame the stale node as live "running Ns".
    expect(text).not.toMatch(/running 26m/i);
  });

  it('treats in_progress as live ONLY when the runner is active for THIS project', async () => {
    const dir = projectWith({
      'scene_clip:scene_3_chunk_2': { status: 'in_progress', startedAt: Date.now() - 30_000 },
    });
    const projectName = dir.split('/').pop()!;
    const r = await tool(async () => ({ known: true, activeProjectName: projectName })).execute('t', { projectDir: dir });
    const text = r.content[0]!.text;
    expect(text).toMatch(/run is active/i);
    expect(text).toMatch(/running 30s/);
    expect(text).not.toMatch(/interrupted/i);
  });

  it('a run active for a DIFFERENT project does not make this project look live', async () => {
    const dir = projectWith({ 'scene_clip:scene_3_chunk_2': { status: 'in_progress', startedAt: Date.now() - 1000 } });
    const r = await tool(async () => ({ known: true, activeProjectName: 'some-other-project' })).execute('t', { projectDir: dir });
    expect(r.content[0]!.text).toMatch(/interrupted/i);
  });

  it('when the runner cannot be consulted (headless), does NOT assert staleness', async () => {
    const dir = projectWith({ 'scene_clip:x': { status: 'in_progress', startedAt: Date.now() - 1000 } });
    const r = await tool(async () => ({ known: false })).execute('t', { projectDir: dir });
    const text = r.content[0]!.text;
    expect(text).not.toMatch(/interrupted/i);
    expect(text).toMatch(/running/i);
  });

  it('no in_progress nodes → never probes, plain summary', async () => {
    const dir = projectWith({ plot: { status: 'completed' }, story: { status: 'failed' } });
    let probed = false;
    const r = await tool(async () => { probed = true; return { known: true }; }).execute('t', { projectDir: dir });
    expect(probed).toBe(false);
    expect(r.content[0]!.text).toMatch(/failed:\s+1/);
  });
});
