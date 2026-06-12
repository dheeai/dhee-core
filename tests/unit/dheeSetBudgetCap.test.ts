/**
 * dhee_set_budget_cap — raise / lower / clear a project's paid-spend cap
 * (features.budgetCapUsd) from chat. This is what the agent calls when a
 * run paused on the budget backstop and the user says "raise it".
 *
 * Behavior pinned here:
 *   1. positive cap → written to features.budgetCapUsd, getBudgetCapUsd reads it.
 *   2. 0 (or negative) → removes the cap (features.budgetCapUsd deleted).
 *   3. preserves the rest of features + top-level keys (walkState, bundleSource).
 *   4. seeds a features object when project.json has none.
 *   5. missing project.json → error.
 *   6. result text steers the agent to resume with dhee_start_run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSetBudgetCapTool } from '../../src/agent/pi/tools/dheeSetBudgetCap.js';
import { getBudgetCapUsd } from '../../src/dag/projectFeatures.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const dirs: string[] = [];
function projectWith(json: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'set-budget-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'project.json'), JSON.stringify(json), 'utf8');
  return dir;
}
function readProject(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
}
const tool = makeSetBudgetCapTool() as unknown as ToolLike;

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('dhee_set_budget_cap', () => {
  it('1. writes a positive cap that getBudgetCapUsd then reads', async () => {
    const dir = projectWith({ bundleSource: 'built-in:x', features: { gateAfterCollections: true } });
    const r = await tool.execute('t', { projectDir: dir, capUsd: 20 });
    expect(r.isError).toBeFalsy();
    const proj = readProject(dir);
    expect((proj.features as Record<string, unknown>).budgetCapUsd).toBe(20);
    expect(getBudgetCapUsd(proj)).toBe(20);
    // Sibling feature flags survive.
    expect((proj.features as Record<string, unknown>).gateAfterCollections).toBe(true);
  });

  it('2. capUsd <= 0 removes the cap (project runs uncapped)', async () => {
    const dir = projectWith({ features: { budgetCapUsd: 5 } });
    const r = await tool.execute('t', { projectDir: dir, capUsd: 0 });
    expect(r.isError).toBeFalsy();
    const proj = readProject(dir);
    expect((proj.features as Record<string, unknown>).budgetCapUsd).toBeUndefined();
    expect(getBudgetCapUsd(proj)).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/uncapped|removed/i);
  });

  it('3. preserves walkState and other top-level keys', async () => {
    const dir = projectWith({
      bundleSource: 'built-in:x',
      name: 'My Project',
      walkState: { nodes: { story: { status: 'completed' } } },
      features: { budgetCapUsd: 3 },
    });
    await tool.execute('t', { projectDir: dir, capUsd: 50 });
    const proj = readProject(dir);
    expect(proj.bundleSource).toBe('built-in:x');
    expect(proj.name).toBe('My Project');
    expect((proj.walkState as { nodes: Record<string, unknown> }).nodes.story).toEqual({
      status: 'completed',
    });
    expect((proj.features as Record<string, unknown>).budgetCapUsd).toBe(50);
  });

  it('4. seeds a features object when the project has none', async () => {
    const dir = projectWith({ bundleSource: 'built-in:x' });
    await tool.execute('t', { projectDir: dir, capUsd: 10 });
    expect((readProject(dir).features as Record<string, unknown>).budgetCapUsd).toBe(10);
  });

  it('5. errors clearly when project.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-budget-empty-'));
    dirs.push(dir);
    const r = await tool.execute('t', { projectDir: dir, capUsd: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/project\.json missing/i);
  });

  it('6. result tells the agent to resume with dhee_start_run', async () => {
    const dir = projectWith({ features: {} });
    const r = await tool.execute('t', { projectDir: dir, capUsd: 15 });
    expect(r.content[0]!.text).toMatch(/dhee_start_run/);
    expect(r.content[0]!.text).toContain('$15.00');
  });
});
