/**
 * dhee_describe_bundle — TDD coverage.
 *
 * The agent calls this after the user picks a bundle, so it can learn
 * what inputs to write, what shape the DAG has, and where each node's
 * artifacts land. Replaces grepping bundle.json via the `read` tool.
 *
 * Failure modes:
 *   1. Known built-in bundle id → returns id + version + description.
 *   2. Returns inputs[] as declared (kind=file path, kind=project field).
 *   3. Returns goal (terminal node id).
 *   4. Returns nodes summary: each node's id, runner.tool, outputs.format,
 *      outputs.pattern, AND the upstream node ids from inputs[].from
 *      (so the agent sees the DAG shape, not just the node list).
 *   5. Unknown bundleId → error listing known.
 *   6. Bundle declaring no top-level inputs[] → inputs is empty array,
 *      not crash.
 *   7. Output is parseable JSON in text content.
 *   8. Bundle id can be passed bare ('narrative_prompt_relay') or with
 *      the 'built-in:' prefix; both resolve.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDescribeBundleTool } from '../../src/agent/pi/tools/dheeDescribeBundle.js';

interface ToolLike {
  execute: (
    id: string,
    params: { bundleId: string },
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function setupBundle(dir: string, manifest: object): string {
  const id = (manifest as { id: string }).id;
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'bundle.json'), JSON.stringify(manifest));
  return id;
}

describe('dhee_describe_bundle', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function setup(manifests: object[]): string {
    const root = mkdtempSync(join(tmpdir(), 'dbd-test-'));
    dirs.push(root);
    for (const m of manifests) setupBundle(root, m);
    return root;
  }

  it('1. known bundle → returns id + version + description', async () => {
    const root = setup([
      {
        id: 'demo',
        version: '0.2.0',
        description: 'A demo bundle for tests.',
        goal: 'final',
        nodes: [{ id: 'final', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'out.md' }, runner: { tool: 'llm.generate', config: {} } }],
      },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'demo' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.id).toBe('demo');
    expect(parsed.version).toBe('0.2.0');
    expect(parsed.description).toBe('A demo bundle for tests.');
  });

  it('2. returns inputs[] declarations verbatim', async () => {
    const root = setup([
      {
        id: 'with_inputs',
        version: '0.1.0',
        description: '',
        goal: 'final',
        inputs: [
          { id: 'story_input', kind: 'file', path: 'inputs/story.md', required: true },
          { id: 'duration', kind: 'project', field: 'targetDuration', default: 60 },
        ],
        nodes: [{ id: 'final', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'out.md' }, runner: { tool: 'llm.generate', config: {} } }],
      },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'with_inputs' });
    const parsed = JSON.parse(r.content[0].text) as { inputs: Array<{ id: string; kind: string; path?: string; field?: string }> };
    expect(parsed.inputs).toHaveLength(2);
    expect(parsed.inputs[0]).toMatchObject({ id: 'story_input', kind: 'file', path: 'inputs/story.md' });
    expect(parsed.inputs[1]).toMatchObject({ id: 'duration', kind: 'project', field: 'targetDuration' });
  });

  it('3. returns goal', async () => {
    const root = setup([
      {
        id: 'with_goal',
        version: '0.1.0',
        goal: 'final_video',
        description: '',
        nodes: [{ id: 'final_video', kind: 'stage', inputs: [], outputs: { format: 'video', pattern: 'v.mp4' }, runner: { tool: 'ffmpeg.concat', config: {} } }],
      },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'with_goal' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.goal).toBe('final_video');
  });

  it('4. nodes summary: id + tool + format + pattern + upstream ids', async () => {
    const root = setup([
      {
        id: 'pipeline',
        version: '0.1.0',
        description: '',
        goal: 'shot_image',
        nodes: [
          { id: 'plot', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'plans/plot.md' }, runner: { tool: 'llm.generate', config: {} } },
          { id: 'shot_image', kind: 'stage', inputs: [{ from: 'plot', usage: 'input' }], outputs: { format: 'image', pattern: 'shots/img.png' }, runner: { tool: 'comfy.image', config: {} } },
        ],
      },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'pipeline' });
    const parsed = JSON.parse(r.content[0].text) as { nodes: Array<{ id: string; runner: string; format: string; outputPattern: string; upstream: string[] }> };
    expect(parsed.nodes).toHaveLength(2);
    const plot = parsed.nodes.find((n) => n.id === 'plot')!;
    expect(plot.runner).toBe('llm.generate');
    expect(plot.format).toBe('md');
    expect(plot.outputPattern).toBe('plans/plot.md');
    expect(plot.upstream).toEqual([]);
    const shot = parsed.nodes.find((n) => n.id === 'shot_image')!;
    expect(shot.upstream).toEqual(['plot']);
  });

  it('5. unknown bundleId → error', async () => {
    const root = setup([
      { id: 'a', version: '0.1.0', description: '', goal: 'n', nodes: [{ id: 'n', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'x' }, runner: { tool: 'llm.generate', config: {} } }] },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/nope|not found|unknown/i);
  });

  it('6. bundle with no inputs[] → empty array, not crash', async () => {
    const root = setup([
      { id: 'no_inputs', version: '0.1.0', description: '', goal: 'n', nodes: [{ id: 'n', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'x' }, runner: { tool: 'llm.generate', config: {} } }] },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'no_inputs' });
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.inputs).toEqual([]);
  });

  it('7. output is parseable JSON', async () => {
    const root = setup([
      { id: 'x', version: '0.1.0', description: '', goal: 'n', nodes: [{ id: 'n', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'x' }, runner: { tool: 'llm.generate', config: {} } }] },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const r = await tool.execute('t', { bundleId: 'x' });
    expect(r.content[0].type).toBe('text');
    expect(() => JSON.parse(r.content[0].text)).not.toThrow();
  });

  it('8. bundleId accepted bare OR with built-in: prefix', async () => {
    const root = setup([
      { id: 'prefixtest', version: '0.1.0', description: '', goal: 'n', nodes: [{ id: 'n', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'x' }, runner: { tool: 'llm.generate', config: {} } }] },
    ]);
    const tool = makeDescribeBundleTool({ bundlesDir: () => root }) as unknown as ToolLike;
    const a = await tool.execute('t', { bundleId: 'prefixtest' });
    const b = await tool.execute('t', { bundleId: 'built-in:prefixtest' });
    expect(JSON.parse(a.content[0].text).id).toBe('prefixtest');
    expect(JSON.parse(b.content[0].text).id).toBe('prefixtest');
  });
});
