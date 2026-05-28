/**
 * dhee pi-agent custom tools — unit tests.
 *
 * Each tool exports a `make<X>Tool(deps)` factory. Tests inject
 * stub deps where the tool would otherwise touch the real bundle
 * runner / LLM, then invoke `tool.execute(...)` directly. The pi
 * SDK's runtime context is mocked as `{} as never`; none of our
 * tools read from it (no telemetry, no streaming updates, no
 * tool-call IDs surfaced to the user).
 *
 * Coverage: happy path + the most likely failure modes per tool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makeCreateProjectTool,
  makeGetStatusTool,
  makeReadArtifactTool,
  makeRegenerateNodeTool,
  makeRunBundleTool,
  DHEE_TOOL_NAMES,
} from '../../src/agent/pi/tools/index.js';

// paths.ts reads `dhee_PROJECTS_DIR` (lowercase prefix — inconsistent
// with DHEE_PI_SESSIONS_DIR; tracked as light tech debt). Until it's
// fixed, mirror the exact name here.
const PROJECTS_ENV = 'dhee_PROJECTS_DIR';
let projectsRoot: string;

beforeEach(() => {
  projectsRoot = mkdtempSync(join(tmpdir(), 'kshana-agent-tools-'));
  process.env[PROJECTS_ENV] = projectsRoot;
});

afterEach(() => {
  delete process.env[PROJECTS_ENV];
  if (projectsRoot) rmSync(projectsRoot, { recursive: true, force: true });
});

const ctx = {} as never;

/* ─────────────── dhee_create_project ─────────────── */

describe('dhee_create_project', () => {
  it('writes project.json under getProjectsDir() with the chosen bundleSource', async () => {
    const tool = makeCreateProjectTool();
    const out = await tool.execute(
      'tc-1',
      { name: 'demo', bundleId: 'narrative_qwen_chain_relay' },
      undefined,
      undefined,
      ctx,
    );

    const projectDir = join(projectsRoot, 'demo');
    expect(existsSync(projectDir)).toBe(true);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.bundleSource).toBe('built-in:narrative_qwen_chain_relay');
    expect(project.name).toBe('demo');
    expect(out.content[0]).toMatchObject({ type: 'text' });
    expect((out.content[0] as { text: string }).text).toContain('demo');
  });

  it('refuses to overwrite an existing project unless overwrite=true', async () => {
    const tool = makeCreateProjectTool();
    await tool.execute(
      'tc-2a',
      { name: 'taken', bundleId: 'narrative_qwen_chain_relay' },
      undefined,
      undefined,
      ctx,
    );
    const second = await tool.execute(
      'tc-2b',
      { name: 'taken', bundleId: 'narrative_qwen_chain_relay' },
      undefined,
      undefined,
      ctx,
    );
    expect(second.isError).toBe(true);
    expect((second.content[0] as { text: string }).text).toMatch(/already exists/i);
  });

  it('rejects an unknown bundleId so the model gets useful feedback', async () => {
    const tool = makeCreateProjectTool({ knownBundleIds: ['narrative_qwen_chain_relay'] });
    const out = await tool.execute(
      'tc-3',
      { name: 'badbundle', bundleId: 'totally_made_up_bundle' },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/unknown bundle/i);
  });
});

/* ─────────────── dhee_get_status ─────────────── */

describe('dhee_get_status', () => {
  function makeProject(name: string, walkStateExtra?: Record<string, unknown>) {
    const projectDir = join(projectsRoot, name);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name,
        bundleSource: 'built-in:narrative_qwen_chain_relay',
        walkState: {
          bundleSource: 'built-in:narrative_qwen_chain_relay',
          bundleVersion: '1.0.0',
          engineVersion: '0.1.0',
          nodes: {},
          lastInvalidatedIds: [],
          ...walkStateExtra,
        },
      }),
      'utf8',
    );
    return projectDir;
  }

  it('summarizes a fresh project as 0/0/0 status counts', async () => {
    const dir = makeProject('fresh');
    const out = await makeGetStatusTool().execute('s-1', { projectDir: dir }, undefined, undefined, ctx);
    expect(out.isError).toBeFalsy();
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/completed:\s*0/i);
    expect(text).toMatch(/failed:\s*0/i);
  });

  it('reports failed nodes with their error text', async () => {
    const dir = makeProject('hasfail', {
      nodes: {
        story: {
          status: 'failed',
          error: 'LLM returned empty response',
          outputPath: undefined,
        },
        'shot_image:scene_1_shot_3': {
          status: 'completed',
          outputPath: 'assets/scene_1/shot_3.png',
          itemId: 'scene_1_shot_3',
        },
      },
    });
    const out = await makeGetStatusTool().execute('s-2', { projectDir: dir }, undefined, undefined, ctx);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/failed:\s*1/i);
    expect(text).toContain('LLM returned empty response');
    expect(text).toContain('story');
  });

  it('errors clearly when project.json is missing', async () => {
    const out = await makeGetStatusTool().execute(
      's-3',
      { projectDir: join(projectsRoot, 'does-not-exist') },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/project\.json not found/i);
  });
});

/* ─────────────── dhee_read_artifact ─────────────── */

describe('dhee_read_artifact', () => {
  function projectWithArtifact(
    name: string,
    nodes: Record<string, { status: string; outputPath?: string; itemId?: string }>,
    files: Array<{ rel: string; content: string }>,
  ): string {
    const projectDir = join(projectsRoot, name);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name,
        bundleSource: 'built-in:narrative_qwen_chain_relay',
        walkState: { bundleSource: '', bundleVersion: '', engineVersion: '', nodes, lastInvalidatedIds: [] },
      }),
      'utf8',
    );
    for (const f of files) {
      const abs = join(projectDir, f.rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, f.content, 'utf8');
    }
    return projectDir;
  }

  it('returns text contents for md / json / text artifacts', async () => {
    const dir = projectWithArtifact(
      'arts-text',
      { story: { status: 'completed', outputPath: 'plans/story.md' } },
      [{ rel: 'plans/story.md', content: '# Story\n\nOnce upon a time...' }],
    );
    const out = await makeReadArtifactTool().execute(
      'r-1',
      { projectDir: dir, nodeId: 'story' },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBeFalsy();
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Once upon a time');
  });

  it('returns path + size for binary artifacts instead of bytes', async () => {
    const dir = projectWithArtifact(
      'arts-image',
      { setting: { status: 'completed', outputPath: 'assets/setting.png' } },
      [{ rel: 'assets/setting.png', content: 'PNG-fake-binary-bytes' }],
    );
    const out = await makeReadArtifactTool().execute(
      'r-2',
      { projectDir: dir, nodeId: 'setting' },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBeFalsy();
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('assets/setting.png');
    expect(text).toMatch(/bytes/i);
    expect(text).not.toContain('PNG-fake-binary-bytes');
  });

  it('resolves the right outputPath for a collection itemId', async () => {
    const dir = projectWithArtifact(
      'arts-coll',
      {
        'shot_image:scene_1_shot_3': {
          status: 'completed',
          outputPath: 'assets/scene_1/shot_3.png',
          itemId: 'scene_1_shot_3',
        },
      },
      [{ rel: 'assets/scene_1/shot_3.png', content: 'shot' }],
    );
    const out = await makeReadArtifactTool().execute(
      'r-3',
      { projectDir: dir, nodeId: 'shot_image', itemId: 'scene_1_shot_3' },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect((out.content[0] as { text: string }).text).toContain('shot_3.png');
  });

  it('errors when the node is not in walkState', async () => {
    const dir = projectWithArtifact('arts-missing', {}, []);
    const out = await makeReadArtifactTool().execute(
      'r-4',
      { projectDir: dir, nodeId: 'nope' },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/not found in walkstate/i);
  });
});

/* ─────────────── dhee_run_bundle ─────────────── */

describe('dhee_run_bundle', () => {
  function makeProject(name: string): string {
    const projectDir = join(projectsRoot, name);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ name, bundleSource: 'built-in:narrative_qwen_chain_relay' }),
      'utf8',
    );
    return projectDir;
  }

  it('returns ok=true and the final video path when the runner succeeds', async () => {
    const dir = makeProject('runok');
    const tool = makeRunBundleTool({
      runProjectViaBundle: vi.fn().mockResolvedValue({
        ok: true,
        finalVideoAbs: '/tmp/foo/final.mp4',
      }),
    });
    const out = await tool.execute('rb-1', { projectDir: dir }, undefined, undefined, ctx);
    expect(out.isError).toBeFalsy();
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('/tmp/foo/final.mp4');
  });

  it('surfaces the runner error verbatim so the agent can act on it', async () => {
    const dir = makeProject('runerr');
    const tool = makeRunBundleTool({
      runProjectViaBundle: vi.fn().mockResolvedValue({
        ok: false,
        error: 'comfyui not reachable at https://comfyui.share.zrok.io',
      }),
    });
    const out = await tool.execute('rb-2', { projectDir: dir }, undefined, undefined, ctx);
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('comfyui not reachable');
  });

  it('passes runOnly through to the runner when supplied', async () => {
    const dir = makeProject('runonly');
    const spy = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRunBundleTool({ runProjectViaBundle: spy });
    await tool.execute(
      'rb-3',
      { projectDir: dir, runOnly: ['shot_image'] },
      undefined,
      undefined,
      ctx,
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ runOnly: ['shot_image'] }));
  });

  it('errors when project.json is missing (so the user gets a clear "no such project")', async () => {
    const tool = makeRunBundleTool({
      runProjectViaBundle: vi.fn().mockResolvedValue({ ok: true }),
    });
    const out = await tool.execute(
      'rb-4',
      { projectDir: join(projectsRoot, 'ghost') },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/project\.json not found/i);
  });
});

/* ─────────────── dhee_regenerate_node ─────────────── */

describe('dhee_regenerate_node', () => {
  function makeProjectWithState(
    name: string,
    nodes: Record<string, { status: string; outputPath?: string; itemId?: string; error?: string }>,
  ): string {
    const projectDir = join(projectsRoot, name);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name,
        bundleSource: 'built-in:narrative_qwen_chain_relay',
        walkState: {
          bundleSource: 'built-in:narrative_qwen_chain_relay',
          bundleVersion: '1.0.0',
          engineVersion: '0.1.0',
          nodes,
          lastInvalidatedIds: [],
        },
      }),
      'utf8',
    );
    return projectDir;
  }

  it('clears the node entry and runs runProjectViaBundle with runOnly=[nodeId]', async () => {
    const dir = makeProjectWithState('regen', {
      story: { status: 'completed', outputPath: 'plans/story.md' },
    });
    const runSpy = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({ runProjectViaBundle: runSpy });

    const out = await tool.execute(
      'rg-1',
      { projectDir: dir, nodeId: 'story' },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ projectDir: dir, runOnly: ['story'] }));

    // After invalidation, the story node entry should be gone from walkState
    // (the walker re-creates it on re-run).
    const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.story).toBeUndefined();
    expect(after.walkState.lastInvalidatedIds).toContain('story');
  });

  it('handles a per-item invalidation for a collection node', async () => {
    const dir = makeProjectWithState('regenitem', {
      'shot_image:scene_1_shot_3': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_3.png',
        itemId: 'scene_1_shot_3',
      },
      'shot_image:scene_1_shot_4': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_4.png',
        itemId: 'scene_1_shot_4',
      },
    });
    const runSpy = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({ runProjectViaBundle: runSpy });

    await tool.execute(
      'rg-2',
      { projectDir: dir, nodeId: 'shot_image', itemId: 'scene_1_shot_3' },
      undefined,
      undefined,
      ctx,
    );

    const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    // shot 3 cleared, shot 4 preserved.
    expect(after.walkState.nodes['shot_image:scene_1_shot_3']).toBeUndefined();
    expect(after.walkState.nodes['shot_image:scene_1_shot_4']).toBeDefined();
  });
});

/* ─────────────── registry surface ─────────────── */

describe('DHEE_TOOL_NAMES', () => {
  it('lists every v1 dhee tool name so the buildSession allowlist can include them', () => {
    expect(DHEE_TOOL_NAMES).toEqual([
      'dhee_create_project',
      'dhee_run_bundle',
      'dhee_get_status',
      'dhee_regenerate_node',
      'dhee_read_artifact',
      'dhee_show_node_output',
      'dhee_show_file',
    ]);
  });
});
