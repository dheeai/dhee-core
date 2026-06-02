/**
 * dhee_set_project_field — persist a project-kind bundle input to
 * project.json when the user states a setting in chat.
 *
 * Failure modes:
 *   1. sets a project-kind field (targetDuration) → written to project.json.
 *   2. numeric option value passed as string ("180") → coerced to number.
 *   3. string option (style='noir') → written as-is.
 *   4. unknown inputId → error listing the settable project-kind ids.
 *   5. file-kind input (story_input) → error pointing at dhee_write_input.
 *   6. missing project.json → error.
 *   7. dot-path field (goal.targetDuration) → written nested.
 *   8. value outside declared options → still written, result notes it.
 *   9. when a plan already exists (completed walkState node) → result tells
 *      the agent to regenerate; when fresh → result says it'll be used on run.
 *  10. never clobbers bundleSource / other top-level keys.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSetProjectFieldTool } from '../../src/agent/pi/tools/dheeSetProjectField.js';
import type { DagBundle } from '../../src/dag/schema.js';

interface ToolLike {
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const FAKE_BUNDLE: DagBundle = {
  id: 'fake',
  version: '0.1.0',
  goal: 'final',
  inputs: [
    { id: 'story_input', kind: 'file', path: 'inputs/story.md', required: true },
    {
      id: 'targetDuration',
      kind: 'project',
      field: 'targetDuration',
      default: 60,
      options: [
        { value: 30, label: '30s' },
        { value: 60, label: '60s' },
        { value: 120, label: '120s' },
        { value: 180, label: '180s' },
      ],
    },
    {
      id: 'style',
      kind: 'project',
      field: 'style',
      default: 'cinematic_realism',
      options: [
        { value: 'cinematic_realism', label: 'Cinematic Realism' },
        { value: 'noir', label: 'Film Noir' },
      ],
    },
    { id: 'nestedDur', kind: 'project', field: 'goal.targetDuration', default: 60, options: [{ value: 30, label: '30' }] },
  ],
  nodes: [],
};

const made: string[] = [];
function tmpProject(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'setfield-'));
  made.push(dir);
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ name: 'p', bundleSource: 'built-in:fake', ...extra }),
  );
  return dir;
}
function readPj(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
}
function tool(): ToolLike {
  return makeSetProjectFieldTool({ loadBundleForProject: () => FAKE_BUNDLE }) as unknown as ToolLike;
}

afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('dhee_set_project_field', () => {
  it('1. sets a project-kind field', async () => {
    const dir = tmpProject();
    const out = await tool().execute('t', { projectDir: dir, inputId: 'targetDuration', value: 180 });
    expect(out.isError).toBeFalsy();
    expect(readPj(dir).targetDuration).toBe(180);
  });

  it('2. coerces a numeric option value passed as string', async () => {
    const dir = tmpProject();
    await tool().execute('t', { projectDir: dir, inputId: 'targetDuration', value: '120' });
    expect(readPj(dir).targetDuration).toBe(120); // number, not "120"
  });

  it('3. writes a string option as-is', async () => {
    const dir = tmpProject();
    await tool().execute('t', { projectDir: dir, inputId: 'style', value: 'noir' });
    expect(readPj(dir).style).toBe('noir');
  });

  it('4. unknown inputId → error listing settable ids', async () => {
    const dir = tmpProject();
    const out = await tool().execute('t', { projectDir: dir, inputId: 'bogus', value: 1 });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/targetDuration/);
    expect(out.content[0].text).toMatch(/style/);
  });

  it('5. file-kind input → error pointing at dhee_write_input', async () => {
    const dir = tmpProject();
    const out = await tool().execute('t', { projectDir: dir, inputId: 'story_input', value: 'x' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/dhee_write_input/);
  });

  it('6. missing project.json → error', async () => {
    const out = await tool().execute('t', { projectDir: '/nope/nowhere', inputId: 'targetDuration', value: 60 });
    expect(out.isError).toBe(true);
  });

  it('7. dot-path field writes nested', async () => {
    const dir = tmpProject();
    await tool().execute('t', { projectDir: dir, inputId: 'nestedDur', value: 30 });
    const pj = readPj(dir) as { goal?: { targetDuration?: number } };
    expect(pj.goal?.targetDuration).toBe(30);
  });

  it('8. value outside options → still written, noted', async () => {
    const dir = tmpProject();
    const out = await tool().execute('t', { projectDir: dir, inputId: 'targetDuration', value: 90 });
    expect(readPj(dir).targetDuration).toBe(90);
    expect(out.content[0].text).toMatch(/not one of the usual|applied anyway/i);
  });

  it('9a. fresh project → result says it will be used on run', async () => {
    const dir = tmpProject();
    const out = await tool().execute('t', { projectDir: dir, inputId: 'targetDuration', value: 180 });
    expect(out.content[0].text).toMatch(/when the pipeline runs|used when/i);
  });

  it('9b. existing plan → result says regenerate', async () => {
    const dir = tmpProject({
      walkState: { nodes: { plot: { status: 'completed', outputPath: 'plans/plot.md' } } },
    });
    const out = await tool().execute('t', { projectDir: dir, inputId: 'targetDuration', value: 180 });
    expect(out.content[0].text).toMatch(/regenerate|already exists/i);
  });

  it('10. never clobbers bundleSource / name', async () => {
    const dir = tmpProject();
    await tool().execute('t', { projectDir: dir, inputId: 'style', value: 'noir' });
    const pj = readPj(dir);
    expect(pj.bundleSource).toBe('built-in:fake');
    expect(pj.name).toBe('p');
  });
});
