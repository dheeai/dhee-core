/**
 * Tests for the pi-agent tools that cross the pi-agent ↔ ExecutorAgent
 * bridge: `runTo` and `regen`. These two are the only tools in
 * src/agent/pi/tools/ that invoke `runExecutor`.
 *
 * What's tested: how each tool maps its tool params → runExecutor opts,
 * how it translates runExecutor callbacks → onUpdate, how it builds the
 * final tool response from runExecutor's result. Project-on-disk
 * concerns (path resolution, project.json reads, validation) are
 * exercised against a temp dir so we catch path bugs too.
 *
 * What's NOT tested here:
 *   - The real runExecutor (covered in runExecutorBridge.test.ts).
 *   - Tools that don't cross the bridge — see uncoveredPiAgentTools.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock runExecutor before importing the tools that consume it.
vi.mock('../../src/server/runners/runExecutor.js', () => {
  return {
    runExecutor: vi.fn(),
  };
});
import { runExecutor } from '../../src/server/runners/runExecutor.js';
import { createRunToTool } from '../../src/agent/pi/tools/runTo.js';

const mockedRunExecutor = vi.mocked(runExecutor);

// ── Temp project fixtures ────────────────────────────────────────────

let projectsDir: string;

function makeProject(name: string, contents: object): string {
  const projectDir = join(projectsDir, `${name}.dhee`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify(contents, null, 2),
  );
  return projectDir;
}

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'dhee-pi-bridge-'));
  process.env['dhee_PROJECTS_DIR'] = projectsDir;
  mockedRunExecutor.mockReset();
});

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  delete process.env['dhee_PROJECTS_DIR'];
});

// Convenience: the tools always return { content, details }; this
// helper lets tests skip the type-narrowing dance. The 5th arg is an
// ExtensionContext that pi-agent tools ignore at runtime — we pass an
// empty object cast to satisfy the signature.
function executeTool(
  tool: ReturnType<typeof createRunToTool>,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: (u: unknown) => void,
) {
  return tool.execute(
    'call-id-1',
    params as never,
    signal as AbortSignal,
    onUpdate as never,
    {} as never,
  );
}

// ── runTo tool ───────────────────────────────────────────────────────

describe('pi-agent runTo tool — bridge to runExecutor', () => {
  it('returns failure when the project directory does not exist', async () => {
    const tool = createRunToTool();
    const result = await executeTool(tool, { project: 'nonexistent' });
    expect((result.details as { status: string }).status).toBe('failed');
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Project not found/);
    expect(mockedRunExecutor).not.toHaveBeenCalled();
  });

  it('returns failure when project.json is missing', async () => {
    // Make a directory but don't write project.json into it.
    mkdirSync(join(projectsDir, 'broken.dhee'), { recursive: true });
    const tool = createRunToTool();
    const result = await executeTool(tool, { project: 'broken' });
    expect((result.details as { status: string }).status).toBe('failed');
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /project.json not found/,
    );
    expect(mockedRunExecutor).not.toHaveBeenCalled();
  });

  it('invokes runExecutor with project + projectDir + empty target when no stage given', async () => {
    makeProject('happy', { templateId: 'narrative', title: 'Happy' });
    mockedRunExecutor.mockResolvedValue({
      status: 'completed',
      stopReason: null,
      rawResultStatus: 'completed',
    });

    const tool = createRunToTool();
    await executeTool(tool, { project: 'happy' });

    expect(mockedRunExecutor).toHaveBeenCalledTimes(1);
    const opts = mockedRunExecutor.mock.calls[0][0];
    expect(opts.projectDir).toBe(join(projectsDir, 'happy.dhee'));
    expect(opts.project).toMatchObject({
      templateId: 'narrative',
      title: 'Happy',
    });
    expect(opts.target).toEqual({});
    expect(opts.name).toBe('pi-agent-run-to');
    // onTool / onResult / onNotification are wired so chat gets progress.
    expect(typeof opts.onTool).toBe('function');
    expect(typeof opts.onResult).toBe('function');
    expect(typeof opts.onNotification).toBe('function');
  });

  it('passes a bare stage through as target.stage', async () => {
    makeProject('p', { templateId: 'narrative' });
    mockedRunExecutor.mockResolvedValue({
      status: 'completed',
      stopReason: null,
      rawResultStatus: 'completed',
    });
    const tool = createRunToTool();
    await executeTool(tool, { project: 'p', stage: 'shot_image' });
    const opts = mockedRunExecutor.mock.calls[0][0];
    expect(opts.target).toMatchObject({ stage: 'shot_image' });
  });

  it('passes skip_media through as target.skipMedia', async () => {
    makeProject('p', { templateId: 'narrative' });
    mockedRunExecutor.mockResolvedValue({
      status: 'completed',
      stopReason: null,
      rawResultStatus: 'completed',
    });
    const tool = createRunToTool();
    await executeTool(tool, { project: 'p', skip_media: true });
    const opts = mockedRunExecutor.mock.calls[0][0];
    expect(opts.target).toMatchObject({ skipMedia: true });
  });

  it('returns failure when an alias is given but project has no executorState', async () => {
    makeProject('p', { templateId: 'narrative' /* no executorState */ });
    const tool = createRunToTool();
    const result = await executeTool(tool, {
      project: 'p',
      stage: 'scene_1_shot_2.image',
    });
    expect((result.details as { status: string }).status).toBe('failed');
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /no executorState yet/,
    );
    expect(mockedRunExecutor).not.toHaveBeenCalled();
  });

  it('translates runExecutor onTool / onResult / onNotification → onUpdate pushLog lines', async () => {
    makeProject('p', { templateId: 'narrative' });
    // Capture the callbacks runExecutor receives so we can fire them.
    let captured: Parameters<typeof runExecutor>[0] | undefined;
    mockedRunExecutor.mockImplementation(async (opts) => {
      captured = opts;
      opts.onTool?.({ toolName: 'image_text_to_image', nodeId: 'shot_1' });
      opts.onResult?.({
        toolName: 'image_text_to_image',
        filePath: '/abs/x.png',
      });
      opts.onResult?.({
        toolName: 'image_text_to_image',
        status: 'completed',
      });
      opts.onNotification?.({ level: 'warning', message: 'slow queue' });
      return {
        status: 'completed',
        stopReason: null,
        rawResultStatus: 'completed',
      };
    });

    const updates: Array<{ details: { log: string } }> = [];
    const tool = createRunToTool();
    await executeTool(tool, { project: 'p' }, undefined, (u: unknown) => {
      updates.push(u as { details: { log: string } });
    });

    expect(captured).toBeDefined();
    // Last update's log accumulates everything in the right format.
    const finalLog = updates[updates.length - 1].details.log;
    expect(finalLog).toContain('  [image_text_to_image] shot_1');
    expect(finalLog).toContain('    → /abs/x.png');
    expect(finalLog).toContain('    → completed');
    expect(finalLog).toContain('  [warning] slow queue');
  });

  it('forwards the AbortSignal to runExecutor', async () => {
    makeProject('p', { templateId: 'narrative' });
    mockedRunExecutor.mockResolvedValue({
      status: 'completed',
      stopReason: null,
      rawResultStatus: 'completed',
    });
    const controller = new AbortController();
    const tool = createRunToTool();
    await executeTool(tool, { project: 'p' }, controller.signal);
    expect(mockedRunExecutor.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('translates runExecutor onAsset → onMedia callback when host provided one', async () => {
    makeProject('myproj', { templateId: 'narrative' });
    mockedRunExecutor.mockImplementation(async (opts) => {
      opts.onAsset?.({
        kind: 'image',
        filePath: '/abs/foo.png',
        toolName: 't1',
        nodeId: 'shot_1',
      });
      return {
        status: 'completed',
        stopReason: null,
        rawResultStatus: 'completed',
      };
    });

    const onMedia = vi.fn();
    const tool = createRunToTool({ onMedia });
    await executeTool(tool, { project: 'myproj' });

    expect(onMedia).toHaveBeenCalledWith({
      kind: 'image',
      path: '/abs/foo.png',
      project: 'myproj',
      source: 'dhee_run_to',
    });
  });

  it('does NOT pass onAsset when no onMedia callback is registered', async () => {
    makeProject('p', { templateId: 'narrative' });
    mockedRunExecutor.mockResolvedValue({
      status: 'completed',
      stopReason: null,
      rawResultStatus: 'completed',
    });
    const tool = createRunToTool(); // no onMedia
    await executeTool(tool, { project: 'p' });
    expect(mockedRunExecutor.mock.calls[0][0].onAsset).toBeUndefined();
  });

  it('maps cancelled result → tool details.status="cancelled" + summary', async () => {
    makeProject('p', { templateId: 'narrative' });
    mockedRunExecutor.mockResolvedValue({
      status: 'cancelled',
      stopReason: 'cancelled',
      rawResultStatus: 'interrupted',
    });
    const tool = createRunToTool();
    const result = await executeTool(tool, { project: 'p' });
    expect((result.details as { status: string }).status).toBe('cancelled');
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /Run cancelled by user/,
    );
  });

  it('maps failed result → tool details with error in summary', async () => {
    makeProject('p', { templateId: 'narrative' });
    mockedRunExecutor.mockResolvedValue({
      status: 'failed',
      stopReason: null,
      error: 'agent exploded',
      rawResultStatus: 'error',
    });
    const tool = createRunToTool();
    const result = await executeTool(tool, { project: 'p' });
    expect((result.details as { status: string }).status).toBe('failed');
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /Run failed.*agent exploded/,
    );
  });
});

// regen tool removed — the LLM-facing dhee_regen / dhee_reset
// tools were collapsed into the unified dhee_invalidate +
// dhee_run_to scope='last_invalidated'. The HTTP /regen endpoint
// (server/agentRoutes.ts) and pnpm regen / pnpm reset CLIs continue
// to use regenNodes / resetProjectStage directly; their tests live
// alongside those modules.
