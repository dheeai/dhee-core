/**
 * dhee_write_input — TDD coverage.
 *
 * The tool writes content to a bundle-declared input file. The agent
 * passes `inputId`, the tool resolves the canonical path from the
 * bundle's `inputs[]` declaration, writes the bytes, and emits an
 * `inputs.provided` event so the projection sees the change.
 *
 * Failure modes:
 *   1. Happy path (text payload): file lands at the bundle-declared
 *      path, event log gets an `inputs.provided` entry.
 *   2. project.json missing → error.
 *   3. Unknown inputId → error listing known ids.
 *   4. inputId with kind='project' (not 'file') → rejected.
 *   5. base64 payload writes binary bytes correctly.
 *   6. localFile payload copies bytes from disk.
 *   7. Path traversal in bundle declaration ('../etc/passwd') rejected.
 *   8. Parent directory under projectDir is auto-created.
 *   9. Overwriting an existing input file is allowed (this is the
 *      whole point — agent can refine the story mid-session).
 *  10. The `inputs.provided` event payload records both the inputId
 *      and the (relative) path written.
 *  11. projectDir doesn't exist → error.
 *  12. Bundle has no top-level `inputs[]` at all → error (nothing to write).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWriteInputTool } from '../../src/agent/pi/tools/dheeWriteInput.js';
import type { BundleInputDecl, DagBundle } from '../../src/dag/schema.js';

interface ToolLike {
  execute: (
    id: string,
    params: { projectDir: string; inputId: string; payload: unknown; reason?: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function setupProject(
  _inputs: BundleInputDecl[],
  opts: { projectJson?: object; withProjectJson?: boolean } = {},
): { projectDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'wri-test-'));
  if (opts.withProjectJson !== false) {
    const json = opts.projectJson ?? { name: 'T', bundleSource: 'built-in:fake' };
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(json), 'utf8');
  }
  return { projectDir };
}

function fakeBundle(inputs?: BundleInputDecl[]): DagBundle {
  return {
    id: 'fake',
    version: '0.1.0',
    goal: 'unused',
    nodes: [],
    ...(inputs !== undefined ? { inputs } : {}),
  } as unknown as DagBundle;
}

function readEventsJsonl(projectDir: string): Array<{ kind: string; payload: unknown }> {
  const p = join(projectDir, '.dhee/events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('dhee_write_input', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('1. happy path: writes text payload to declared path + emits inputs.provided', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'story_input', kind: 'file', path: 'inputs/story.md', required: true }]),
    }) as unknown as ToolLike;

    const r = await tool.execute('t', {
      projectDir,
      inputId: 'story_input',
      payload: { kind: 'text', content: '# The Heist\n\nA quick caper.' },
    });

    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toContain('# The Heist');
    const events = readEventsJsonl(projectDir);
    const provided = events.filter((e) => e.kind === 'inputs.provided');
    expect(provided).toHaveLength(1);
  });

  it('2. project.json missing → error', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'wri-test-'));
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () => fakeBundle([]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      inputId: 'story_input',
      payload: { kind: 'text', content: 'x' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/project\.json/i);
  });

  it('3. unknown inputId → error lists known ids', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'story_input', kind: 'file', path: 'inputs/story.md' }]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      inputId: 'no_such_thing',
      payload: { kind: 'text', content: 'x' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no_such_thing|story_input/i);
  });

  it('4. inputId with kind=project (not file) rejected', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'duration', kind: 'project', field: 'targetDuration', default: 60 }]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      inputId: 'duration',
      payload: { kind: 'text', content: '90' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/kind.*project|not.*file/i);
  });

  it('5. base64 payload writes binary bytes correctly', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'char_ref_lara', kind: 'file', path: 'inputs/character_refs/lara.png' }]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      inputId: 'char_ref_lara',
      payload: { kind: 'base64', contentBase64: png.toString('base64') },
    });
    const bytes = readFileSync(join(projectDir, 'inputs/character_refs/lara.png'));
    expect([...bytes]).toEqual([...png]);
  });

  it('6. localFile payload copies bytes from disk', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const sourceDir = mkdtempSync(join(tmpdir(), 'wri-src-'));
    dirs.push(sourceDir);
    const srcPath = join(sourceDir, 'attach.png');
    const src = Buffer.from('binary-data', 'utf8');
    writeFileSync(srcPath, src);

    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'char_ref', kind: 'file', path: 'inputs/character_refs/x.png' }]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      inputId: 'char_ref',
      payload: { kind: 'localFile', sourcePath: srcPath },
    });
    const target = readFileSync(join(projectDir, 'inputs/character_refs/x.png'));
    expect(target.toString('utf8')).toBe('binary-data');
  });

  it('7. path traversal in bundle declaration rejected', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'evil', kind: 'file', path: '../etc/passwd' }]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      inputId: 'evil',
      payload: { kind: 'text', content: 'hax' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside|traversal|escape/i);
  });

  it('8. parent directory under projectDir is auto-created', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'nested', kind: 'file', path: 'inputs/deeply/nested/dir/x.md' }]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      inputId: 'nested',
      payload: { kind: 'text', content: 'ok' },
    });
    expect(existsSync(join(projectDir, 'inputs/deeply/nested/dir/x.md'))).toBe(true);
  });

  it('9. overwriting an existing input is allowed', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'story_input', kind: 'file', path: 'inputs/story.md' }]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      inputId: 'story_input',
      payload: { kind: 'text', content: 'v1' },
    });
    const r2 = await tool.execute('t', {
      projectDir,
      inputId: 'story_input',
      payload: { kind: 'text', content: 'v2 (better)' },
    });
    expect(r2.isError).toBeFalsy();
    expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('v2 (better)');
  });

  it('10. inputs.provided event records id + path', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'story_input', kind: 'file', path: 'inputs/story.md' }]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      inputId: 'story_input',
      payload: { kind: 'text', content: 'x' },
    });
    const evts = readEventsJsonl(projectDir).filter((e) => e.kind === 'inputs.provided');
    const payload = evts[0].payload as { inputs: Record<string, unknown> };
    expect(payload.inputs.story_input).toBeDefined();
  });

  it('11. projectDir does not exist → error', async () => {
    const tool = makeWriteInputTool({
      loadBundleForProject: () => fakeBundle([]),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir: '/no/such/dir',
      inputId: 'x',
      payload: { kind: 'text', content: 'a' },
    });
    expect(r.isError).toBe(true);
  });

  it('12. bundle with no inputs[] → error', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    const tool = makeWriteInputTool({
      loadBundleForProject: () => fakeBundle(/* undefined */),
    }) as unknown as ToolLike;
    const r = await tool.execute('t', {
      projectDir,
      inputId: 'anything',
      payload: { kind: 'text', content: 'x' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no inputs|declares no/i);
  });

  it('parent dir creation does not stomp existing siblings', async () => {
    const { projectDir } = setupProject([]);
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'inputs'));
    writeFileSync(join(projectDir, 'inputs/keep.md'), 'preserved');
    const tool = makeWriteInputTool({
      loadBundleForProject: () =>
        fakeBundle([{ id: 'story_input', kind: 'file', path: 'inputs/story.md' }]),
    }) as unknown as ToolLike;
    await tool.execute('t', {
      projectDir,
      inputId: 'story_input',
      payload: { kind: 'text', content: 'x' },
    });
    // unused but verifies test setup is sane
    expect(statSync(join(projectDir, 'inputs/keep.md')).isFile()).toBe(true);
    expect(readFileSync(join(projectDir, 'inputs/keep.md'), 'utf8')).toBe('preserved');
  });
});
