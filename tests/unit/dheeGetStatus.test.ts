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
function projectWithGate(
  nodes: Record<string, { status: string; startedAt?: number }>,
  pausedAtGate: { gatedAfter: string; pendingAfterGate?: string[] },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'getstatus-gate-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ walkState: { nodes }, pausedAtGate }), 'utf8');
  return dir;
}
function projectWithBudget(
  nodes: Record<string, { status: string; startedAt?: number }>,
  pausedAtBudget: { capUsd: number; spentUsd: number; nextNodeId: string; itemId?: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'getstatus-budget-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ walkState: { nodes }, pausedAtBudget }), 'utf8');
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
    expect(text).toMatch(/dhee_start_run|dispatch a run/i);
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

describe('dhee_get_status — gate pause on the PULL path (issue #133)', () => {
  it('surfaces a PAUSED-AT-GATE banner when idle with a gate marker, steering away from resume/confabulation', async () => {
    const dir = projectWithGate(
      { story: { status: 'completed' }, shot_image_prompt: { status: 'completed' } },
      { gatedAfter: 'shot_image_prompt', pendingAfterGate: ['shot_image', 'scene_clip', 'final_video'] },
    );
    const r = await tool(async () => ({ known: true })).execute('t', { projectDir: dir });
    const text = r.content[0]!.text;
    // The banner must be unmistakable and lead the output.
    expect(text).toMatch(/paused at the gate/i);
    expect(text).toContain('shot_image_prompt');
    expect(text).toMatch(/gateAfterCollections|stop after each collection/i);
    // Names what's still pending.
    expect(text).toContain('final_video');
    // Steers the agent off the two observed failure modes:
    expect(text).toMatch(/do NOT dispatch another run|never auto-resume|wait for them/i);
    expect(text).toMatch(/ComfyUI/);
    // Idle counts must NOT be read as "finished".
    expect(text).toMatch(/intentional/i);
  });

  it('does NOT show the gate banner while a resume is actively in progress (in_progress > 0)', async () => {
    const dir = projectWithGate(
      { story: { status: 'completed' }, scene_clip: { status: 'in_progress', startedAt: Date.now() - 5000 } },
      { gatedAfter: 'shot_image_prompt', pendingAfterGate: ['final_video'] },
    );
    const projectName = dir.split('/').pop()!;
    const r = await tool(async () => ({ known: true, activeProjectName: projectName })).execute('t', { projectDir: dir });
    const text = r.content[0]!.text;
    // An active run supersedes a stale marker — show progress, not a pause.
    expect(text).not.toMatch(/paused at the gate/i);
    expect(text).toMatch(/run is active/i);
  });

  it('no gate banner when there is no pausedAtGate marker (plain idle project)', async () => {
    const dir = projectWith({ story: { status: 'completed' }, final_video: { status: 'completed' } });
    const r = await tool(async () => ({ known: true })).execute('t', { projectDir: dir });
    expect(r.content[0]!.text).not.toMatch(/paused at the gate/i);
  });
});

describe('dhee_get_status — budget-cap pause on the PULL path', () => {
  it('surfaces a PAUSED-AT-BUDGET banner when idle with a budget marker', async () => {
    const dir = projectWithBudget(
      { upstream: { status: 'completed' }, shot_image: { status: 'completed' } },
      { capUsd: 3, spentUsd: 4, nextNodeId: 'shot_image', itemId: 'scene_1_shot_2' },
    );
    const r = await tool(async () => ({ known: true })).execute('t', { projectDir: dir });
    const text = r.content[0]!.text;
    expect(text).toMatch(/paused at the budget cap/i);
    expect(text).toContain('$3.00');
    expect(text).toContain('$4.00');
    // Steers off resume (which would re-trip) and off blaming a misconfig.
    expect(text).toMatch(/do NOT resume/i);
    expect(text).toMatch(/intentional/i);
    expect(text).toMatch(/raise it|Settings/i);
  });

  it('does NOT show the budget banner while a run is actively in progress', async () => {
    const dir = projectWithBudget(
      { upstream: { status: 'in_progress', startedAt: Date.now() - 5000 } },
      { capUsd: 3, spentUsd: 4, nextNodeId: 'shot_image' },
    );
    const projectName = dir.split('/').pop()!;
    const r = await tool(async () => ({ known: true, activeProjectName: projectName })).execute('t', { projectDir: dir });
    expect(r.content[0]!.text).not.toMatch(/paused at the budget cap/i);
  });

  it('no budget banner when there is no pausedAtBudget marker', async () => {
    const dir = projectWith({ story: { status: 'completed' }, final_video: { status: 'completed' } });
    const r = await tool(async () => ({ known: true })).execute('t', { projectDir: dir });
    expect(r.content[0]!.text).not.toMatch(/paused at the budget cap/i);
  });
});
