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
  makeAskQuestionTool,
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

describe('dhee_run_bundle (Phase 6.5c.c — BackgroundTaskRunner dispatch)', () => {
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

  /**
   * Fake BackgroundTaskRunner — captures the dispatched spec + lets
   * tests drive 'completed' / 'failed' / 'cancelled' by id. Mirrors
   * the real runner's `on(event, handler) → unsubscribe` signature.
   */
  function makeFakeRunner() {
    const handlers: Record<string, Array<(payload: { task: { id: string }; error?: string }) => void>> = {
      completed: [],
      failed: [],
      cancelled: [],
    };
    let lastDispatch: { spec: unknown; taskId: string } | null = null;
    let rejectNext: { reason: string; activeTaskId: string; activeProjectName: string } | null = null;
    const runner = {
      dispatch(spec: unknown) {
        if (rejectNext) {
          const r = rejectNext;
          rejectNext = null;
          return { status: 'rejected' as const, reason: r.reason, activeTaskId: r.activeTaskId, activeProjectName: r.activeProjectName };
        }
        const taskId = `t-${Math.random().toString(36).slice(2, 6)}`;
        lastDispatch = { spec, taskId };
        return { status: 'started' as const, taskId };
      },
      on(event: 'completed' | 'failed' | 'cancelled', handler: (p: { task: { id: string }; error?: string }) => void) {
        handlers[event].push(handler);
        return () => {
          handlers[event] = handlers[event].filter((h) => h !== handler);
        };
      },
    };
    return {
      runner: runner as never,
      fire(event: 'completed' | 'failed' | 'cancelled', payload: { task: { id: string }; error?: string }) {
        for (const h of handlers[event]) h(payload);
      },
      getLastDispatch: () => lastDispatch,
      rejectNextWith(reason: { reason: string; activeTaskId: string; activeProjectName: string }) {
        rejectNext = reason;
      },
    };
  }

  it('dispatches via BackgroundTaskRunner and resolves on the matching completed event', async () => {
    const dir = makeProject('runok');
    const { runner, fire, getLastDispatch } = makeFakeRunner();
    const tool = makeRunBundleTool({ getBackgroundTaskRunner: () => runner });

    const promise = tool.execute('rb-1', { projectDir: dir }, undefined, undefined, ctx);
    // Allow dispatch microtask to settle before firing the event.
    await Promise.resolve();
    const d = getLastDispatch();
    expect(d).not.toBeNull();
    fire('completed', { task: { id: d!.taskId } });
    const out = await promise;
    expect((out as { isError?: boolean }).isError).toBeFalsy();
    expect((out.content[0] as { text: string }).text).toMatch(/completed/i);
  });

  it('forwards stopAt as `stage` and runOnly through to the runner spec', async () => {
    const dir = makeProject('rundisp');
    const { runner, fire, getLastDispatch } = makeFakeRunner();
    const tool = makeRunBundleTool({ getBackgroundTaskRunner: () => runner });

    const promise = tool.execute(
      'rb-2',
      { projectDir: dir, stopAt: 'shot_image', runOnly: ['shot_image'] },
      undefined,
      undefined,
      ctx,
    );
    await Promise.resolve();
    const d = getLastDispatch()!;
    const spec = d.spec as { kind: string; params: { stage?: string; runOnly?: string[] } };
    expect(spec.kind).toBe('run_to');
    expect(spec.params.stage).toBe('shot_image');
    expect(spec.params.runOnly).toEqual(['shot_image']);
    fire('completed', { task: { id: d.taskId } });
    await promise;
  });

  it('returns isError=true when the runner fires `failed` with an error', async () => {
    const dir = makeProject('runerr');
    const { runner, fire, getLastDispatch } = makeFakeRunner();
    const tool = makeRunBundleTool({ getBackgroundTaskRunner: () => runner });
    const promise = tool.execute('rb-3', { projectDir: dir }, undefined, undefined, ctx);
    await Promise.resolve();
    fire('failed', {
      task: { id: getLastDispatch()!.taskId },
      error: 'comfyui not reachable',
    });
    const out = await promise;
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain('comfyui not reachable');
  });

  it('returns isError=true when the runner fires `cancelled`', async () => {
    const dir = makeProject('runcancel');
    const { runner, fire, getLastDispatch } = makeFakeRunner();
    const tool = makeRunBundleTool({ getBackgroundTaskRunner: () => runner });
    const promise = tool.execute('rb-4', { projectDir: dir }, undefined, undefined, ctx);
    await Promise.resolve();
    fire('cancelled', { task: { id: getLastDispatch()!.taskId } });
    const out = await promise;
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/cancelled/i);
  });

  it('returns isError=true when the runner rejects dispatch (task already running)', async () => {
    const dir = makeProject('runbusy');
    const { runner, rejectNextWith } = makeFakeRunner();
    const tool = makeRunBundleTool({ getBackgroundTaskRunner: () => runner });
    rejectNextWith({
      reason: 'task_already_running',
      activeTaskId: 't-other',
      activeProjectName: 'OtherProject',
    });
    const out = await tool.execute('rb-5', { projectDir: dir }, undefined, undefined, ctx);
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/already in flight/i);
  });

  it('errors when project.json is missing', async () => {
    const { runner } = makeFakeRunner();
    const tool = makeRunBundleTool({ getBackgroundTaskRunner: () => runner });
    const out = await tool.execute(
      'rb-6',
      { projectDir: join(projectsRoot, 'ghost') },
      undefined,
      undefined,
      ctx,
    );
    expect((out as { isError?: boolean }).isError).toBe(true);
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

  it('clears the node entry + dispatches runProjectViaBundle (no runOnly — cascade-invalidation does the work)', async () => {
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
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ projectDir: dir }));
    // Post-cascade: invalidateNodes cascaded through the event-derived
    // dep graph BEFORE dispatch, so the walker re-runs everything
    // pending without a runOnly hint.
    expect(runSpy).toHaveBeenCalledWith(expect.not.objectContaining({ runOnly: expect.anything() }));

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

/* ─────────────── dhee_ask_question ─────────────── */

describe('dhee_ask_question', () => {
  const parse = (out: { content: ReadonlyArray<unknown> }) =>
    JSON.parse((out.content[0] as { text: string }).text);

  it('echoes a question_choices payload the desktop picker can parse', async () => {
    const tool = makeAskQuestionTool();
    const out = await tool.execute(
      'q-1',
      {
        question: 'Add Chitra the leopard?',
        options: [
          { id: 'yes', label: 'Yes, add Chitra', description: 'Regenerate everything' },
          { id: 'skip', label: 'Skip for now' },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    const payload = parse(out);
    // The exact shape the desktop's question_choices parser reads.
    expect(payload.kind).toBe('question_choices');
    expect(payload.question).toBe('Add Chitra the leopard?');
    expect(payload.options).toEqual([
      { id: 'yes', label: 'Yes, add Chitra', description: 'Regenerate everything' },
      { id: 'skip', label: 'Skip for now' },
    ]);
    expect(payload.multiSelect).toBe(false);
  });

  it('carries a directive that tells the model to STOP and not answer its own question', async () => {
    // Root cause of the field bug: the model called the tool then picked
    // an option for the user ("skip for now") instead of waiting. The
    // result must instruct it to end the turn.
    const tool = makeAskQuestionTool();
    const out = await tool.execute(
      'q-2',
      { question: 'A or B?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      undefined,
      undefined,
      ctx,
    );
    const payload = parse(out);
    expect(typeof payload._agentDirective).toBe('string');
    expect(payload._agentDirective).toMatch(/end your turn/i);
    expect(payload._agentDirective).toMatch(/do not|don't|wait/i);
  });

  it('rejects an empty question and empty options with isError', async () => {
    const tool = makeAskQuestionTool();
    const noQ = await tool.execute('q-3', { question: '   ', options: [{ id: 'a', label: 'A' }] }, undefined, undefined, ctx);
    expect(noQ.isError).toBe(true);
    const noOpts = await tool.execute('q-4', { question: 'pick', options: [] }, undefined, undefined, ctx);
    expect(noOpts.isError).toBe(true);
  });

  it('rejects duplicate option ids so the picker echoes an unambiguous id', async () => {
    const tool = makeAskQuestionTool();
    const out = await tool.execute(
      'q-5',
      { question: 'pick', options: [{ id: 'x', label: 'One' }, { id: 'x', label: 'Two' }] },
      undefined,
      undefined,
      ctx,
    );
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/duplicate/i);
  });
});

/* ─────────────── registry surface ─────────────── */

describe('DHEE_TOOL_NAMES', () => {
  it('lists every v1 dhee tool name so the buildSession allowlist can include them', () => {
    expect(DHEE_TOOL_NAMES).toEqual([
      'dhee_create_project',
      'dhee_ask_question',
      'dhee_list_bundles',
      'dhee_present_bundle_choices',
      'dhee_describe_bundle',
      'dhee_run_bundle',
      'dhee_start_run',
      'dhee_stop_run',
      'dhee_get_status',
      'dhee_regenerate_node',
      'dhee_critique_node',
      'dhee_check_resolution',
      'dhee_check_workflow',
      'dhee_apply_workflow_aliases',
      'dhee_read_artifact',
      'dhee_show_node_output',
      'dhee_show_file',
      'dhee_list_versions',
      'dhee_select_version',
      'dhee_fork',
      'dhee_swap_runner',
      'dhee_write_input',
      'dhee_write_node_content',
      'dhee_set_project_field',
      'dhee_read',
      'dhee_ls',
      'dhee_grep',
      'dhee_find',
    ]);
  });
});
