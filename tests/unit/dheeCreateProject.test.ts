/**
 * dhee_create_project — TDD coverage for the `existingDir` mode added
 * to support agent-led onboarding. Today the desktop creates the folder
 * (~/dhee-studios/<name>) when the user clicks "+New Project"; the
 * agent then populates project.json into that folder rather than
 * creating a fresh sibling.
 *
 * Failure modes:
 *
 *   Legacy (no existingDir):
 *     1. Creates <projectsDir>/<name>/project.json with bundleSource
 *        set to built-in:<bundleId>.
 *     2. Refuses to overwrite an existing dir.
 *     3. Unknown bundleId rejected when knownBundleIds is supplied.
 *
 *   existingDir mode:
 *     4. existingDir provided + dir exists + no project.json
 *        → writes project.json INSIDE existingDir.
 *     5. The `name` param drives the project.json `name` field; the
 *        physical directory comes from `existingDir`.
 *     6. existingDir provided + project.json already exists
 *        → refuses (no overwrite).
 *     7. existingDir provided + dir doesn't exist
 *        → error (caller's responsibility to create the folder first).
 *     8. existingDir + unknown bundleId still rejected.
 *     9. Optional `description` recorded in either mode.
 *    10. `createdAt` is an ISO string in both modes.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCreateProjectTool } from '../../src/agent/pi/tools/dheeCreateProject.js';

interface ToolLike {
  execute: (
    id: string,
    params: { name: string; bundleId: string; existingDir?: string; description?: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dhee-create-test-'));
}

describe('dhee_create_project', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('1. legacy: creates <projectsDir>/<name>/project.json with bundleSource', async () => {
    const projectsDir = tmpRoot();
    made.push(projectsDir);
    const tool = makeCreateProjectTool({ getProjectsDir: () => projectsDir }) as unknown as ToolLike;
    await tool.execute('t', { name: 'MyProj', bundleId: 'narrative_prompt_relay' });
    const projectJson = JSON.parse(readFileSync(join(projectsDir, 'MyProj', 'project.json'), 'utf8'));
    expect(projectJson.name).toBe('MyProj');
    expect(projectJson.bundleSource).toBe('built-in:narrative_prompt_relay');
  });

  it('2. legacy: refuses to overwrite an existing dir', async () => {
    const projectsDir = tmpRoot();
    made.push(projectsDir);
    mkdirSync(join(projectsDir, 'Existing'));
    const tool = makeCreateProjectTool({ getProjectsDir: () => projectsDir }) as unknown as ToolLike;
    const r = await tool.execute('t', { name: 'Existing', bundleId: 'narrative_prompt_relay' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('already exists');
  });

  it('3. legacy: unknown bundleId rejected', async () => {
    const projectsDir = tmpRoot();
    made.push(projectsDir);
    const tool = makeCreateProjectTool({
      getProjectsDir: () => projectsDir,
      knownBundleIds: ['narrative_prompt_relay'],
    }) as unknown as ToolLike;
    const r = await tool.execute('t', { name: 'X', bundleId: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("unknown bundle 'nope'");
  });

  it('4. existingDir: writes project.json INSIDE the existing folder', async () => {
    const projectsDir = tmpRoot();
    made.push(projectsDir);
    const existingDir = tmpRoot();
    made.push(existingDir);
    const tool = makeCreateProjectTool({ getProjectsDir: () => projectsDir }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      name: 'IslandZ',
      bundleId: 'narrative_qwen_chain_relay',
      existingDir,
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(existingDir, 'project.json'))).toBe(true);
    // Did NOT create a sibling under projectsDir.
    expect(existsSync(join(projectsDir, 'IslandZ'))).toBe(false);
  });

  it('5. existingDir: `name` drives project.json name; dir path from existingDir', async () => {
    const existingDir = tmpRoot();
    made.push(existingDir);
    const tool = makeCreateProjectTool() as unknown as ToolLike;
    await tool.execute('t', {
      name: 'Island Zombie Survival',
      bundleId: 'narrative_prompt_relay',
      existingDir,
    });
    const project = JSON.parse(readFileSync(join(existingDir, 'project.json'), 'utf8'));
    expect(project.name).toBe('Island Zombie Survival');
    expect(project.bundleSource).toBe('built-in:narrative_prompt_relay');
  });

  it('6. existingDir: refuses when project.json already exists', async () => {
    const existingDir = tmpRoot();
    made.push(existingDir);
    writeFileSync(join(existingDir, 'project.json'), '{}', 'utf8');
    const tool = makeCreateProjectTool() as unknown as ToolLike;
    const r = await tool.execute('t', {
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      existingDir,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('project.json already exists');
  });

  it('7. existingDir: errors when dir does not exist', async () => {
    const projectsDir = tmpRoot();
    made.push(projectsDir);
    const tool = makeCreateProjectTool({ getProjectsDir: () => projectsDir }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      existingDir: '/nonexistent/path/that/never/was',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.toLowerCase()).toMatch(/not found|does not exist/);
  });

  it('8. existingDir: unknown bundleId still rejected', async () => {
    const existingDir = tmpRoot();
    made.push(existingDir);
    const tool = makeCreateProjectTool({
      knownBundleIds: ['narrative_prompt_relay'],
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      name: 'X',
      bundleId: 'nope',
      existingDir,
    });
    expect(r.isError).toBe(true);
  });

  it('9. optional description recorded in either mode', async () => {
    // Legacy mode.
    const projectsDir = tmpRoot();
    made.push(projectsDir);
    const tool = makeCreateProjectTool({ getProjectsDir: () => projectsDir }) as unknown as ToolLike;
    await tool.execute('t', { name: 'Legacy', bundleId: 'narrative_prompt_relay', description: 'a legacy thing' });
    const legacy = JSON.parse(readFileSync(join(projectsDir, 'Legacy', 'project.json'), 'utf8'));
    expect(legacy.description).toBe('a legacy thing');

    // existingDir mode.
    const existingDir = tmpRoot();
    made.push(existingDir);
    await tool.execute('t', { name: 'Existing', bundleId: 'narrative_prompt_relay', description: 'existing thing', existingDir });
    const existing = JSON.parse(readFileSync(join(existingDir, 'project.json'), 'utf8'));
    expect(existing.description).toBe('existing thing');
  });

  it('10. createdAt is an ISO date string', async () => {
    const existingDir = tmpRoot();
    made.push(existingDir);
    const tool = makeCreateProjectTool() as unknown as ToolLike;
    await tool.execute('t', { name: 'Time', bundleId: 'narrative_prompt_relay', existingDir });
    const p = JSON.parse(readFileSync(join(existingDir, 'project.json'), 'utf8'));
    expect(typeof p.createdAt).toBe('string');
    // ISO format check: parseable + round-trippable.
    expect(new Date(p.createdAt).toISOString()).toBe(p.createdAt);
  });
});
