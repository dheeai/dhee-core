/**
 * Regression: dispatcher honors only stage gates that make sense for
 * the project's renderMethod.
 *
 * Live failure: a prompt_relay project test ran shot-by-shot through
 * the legacy FL2V Cloud workflow. Root cause was the chat agent
 * issuing `dhee_run_to stage='shot_video'` (proactively trying to
 * "advance to the next stage"), and the dispatcher passing that stage
 * to runExecutor verbatim — meaning the executor ran all the per-shot
 * FL2V renders AND the dispatcher skipped bundle dispatch (because
 * stage != shot_image was treated as "caller iterating upstream").
 *
 * Fix: for prompt_relay, stage='shot_video' has no semantic meaning
 * (the bundle renders the video, not per-shot FL2V). The dispatcher
 * rewrites it to undefined, runs the executor gated at shot_image,
 * and dispatches the bundle. stage='final_video' gets the same
 * treatment (terminal goal = bundle's job).
 *
 * Tests stub runExecutor + walkBundle so they capture inputs without
 * doing real work. Behavioral assertion is on the captured stage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture what the dispatcher passes to runExecutor / walkBundle.
const runExecutorMock = vi.fn();
const walkBundleMock = vi.fn();

vi.mock('../../src/server/runners/runExecutor.js', () => ({
  runExecutor: (opts: unknown) => runExecutorMock(opts),
}));

vi.mock('../../src/dag/walker.js', async () => {
  const real = await vi.importActual<typeof import('../../src/dag/walker.js')>(
    '../../src/dag/walker.js',
  );
  return {
    ...real,
    walkBundle: (opts: unknown) => walkBundleMock(opts),
  };
});

import { runProjectInProcess } from '../../src/server/runners/runProjectInProcess.js';

describe('runProjectInProcess: stage-gate rewriting for prompt_relay', () => {
  let projectDir: string;

  beforeEach(() => {
    runExecutorMock.mockReset();
    walkBundleMock.mockReset();

    // Default mocks: executor finishes cleanly (paused_at_stage),
    // bundle walk finishes cleanly with a stub final video path.
    runExecutorMock.mockResolvedValue({
      status: 'completed',
      rawResultStatus: 'paused_at_stage',
      stopReason: 'paused_at_stage',
    });
    walkBundleMock.mockResolvedValue({
      ok: true,
      goal: {
        outputRel: 'assets/videos/final/dag_relay_final.mp4',
        outputAbs: '/tmp/fake/dag_relay_final.mp4',
      },
      instances: [],
    });

    projectDir = mkdtempSync(join(tmpdir(), 'dispatcher-stage-'));
    // Minimal scene file so discoverSceneIds returns something.
    mkdirSync(join(projectDir, 'prompts/videos/scenes'), { recursive: true });
    writeFileSync(
      join(projectDir, 'prompts/videos/scenes/scene_1.json'),
      JSON.stringify({ sceneNumber: 1, shots: [] }),
    );
  });

  const baseProject = {
    version: '3.0',
    id: 'test',
    title: 'test',
    renderMethod: 'prompt_relay',
  } as unknown as Parameters<typeof runProjectInProcess>[0]['project'];

  it("rewrites stage='shot_video' to run-to-completion (executor gated at shot_image + bundle)", async () => {
    const logs: string[] = [];
    const result = await runProjectInProcess({
      projectDir,
      project: baseProject,
      runExecutorExtras: { target: { stage: 'shot_video' } },
      log: (m) => logs.push(m),
    });

    expect(runExecutorMock).toHaveBeenCalledOnce();
    const executorOpts = runExecutorMock.mock.calls[0]![0] as {
      target: { stage?: string };
    };
    // The executor MUST gate at shot_image, not at shot_video — running
    // shot_video would invoke the legacy per-shot FL2V path.
    expect(executorOpts.target.stage).toBe('shot_image');

    // And the bundle MUST be dispatched (the relay is what produces
    // the final video for prompt_relay).
    expect(walkBundleMock).toHaveBeenCalledOnce();

    expect(result.ok).toBe(true);
    expect(result.method).toBe('prompt_relay');

    // The user-visible warning that the override happened.
    expect(logs.some((l) => /ignoring stage='shot_video'/.test(l))).toBe(true);
  });

  it("honors stage='final_video' as a shared terminal stage (executor + bundle)", async () => {
    // final_video is genuinely shared across methods — both produce
    // one. For prompt_relay the executor still gates at shot_image
    // (that's the relay's natural pause point), then the bundle
    // produces the final. End-to-end behavior matches "run to
    // completion." No rewrite, no warning — final_video is a
    // legitimate gate request in either method.
    const logs: string[] = [];
    await runProjectInProcess({
      projectDir,
      project: baseProject,
      runExecutorExtras: { target: { stage: 'final_video' } },
      log: (m) => logs.push(m),
    });

    const executorOpts = runExecutorMock.mock.calls[0]![0] as {
      target: { stage?: string };
    };
    expect(executorOpts.target.stage).toBe('shot_image');
    expect(walkBundleMock).toHaveBeenCalledOnce();
    // No "ignoring" warning — this stage is legitimate.
    expect(logs.some((l) => /ignoring/.test(l))).toBe(false);
  });

  it("treats stage='shot_image' as the natural relay-gate point (executor + bundle)", async () => {
    // shot_image is exactly where the prompt_relay path naturally
    // pauses the executor (relay takes over for video synthesis), so
    // a caller-specified stage='shot_image' is read as "run all the
    // way" — equivalent to no gate. To stop at shot_image WITHOUT
    // relay, the caller must specify an earlier stage.
    const result = await runProjectInProcess({
      projectDir,
      project: baseProject,
      runExecutorExtras: { target: { stage: 'shot_image' } },
    });

    const executorOpts = runExecutorMock.mock.calls[0]![0] as {
      target: { stage?: string };
    };
    expect(executorOpts.target.stage).toBe('shot_image');
    expect(walkBundleMock).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("honors stage='character_image' (genuine upstream iteration; skip bundle)", async () => {
    await runProjectInProcess({
      projectDir,
      project: baseProject,
      runExecutorExtras: { target: { stage: 'character_image' } },
    });

    const executorOpts = runExecutorMock.mock.calls[0]![0] as {
      target: { stage?: string };
    };
    expect(executorOpts.target.stage).toBe('character_image');
    expect(walkBundleMock).not.toHaveBeenCalled();
  });

  it('default (no stage gate) runs executor at shot_image + dispatches bundle', async () => {
    await runProjectInProcess({
      projectDir,
      project: baseProject,
      runExecutorExtras: { target: {} },
    });

    const executorOpts = runExecutorMock.mock.calls[0]![0] as {
      target: { stage?: string };
    };
    expect(executorOpts.target.stage).toBe('shot_image');
    expect(walkBundleMock).toHaveBeenCalledOnce();
  });

  it('shot_by_shot method passes stage verbatim and skips bundle entirely', async () => {
    const shotByShotProject = {
      ...baseProject,
      renderMethod: 'shot_by_shot',
    };
    await runProjectInProcess({
      projectDir,
      project: shotByShotProject as Parameters<typeof runProjectInProcess>[0]['project'],
      runExecutorExtras: { target: { stage: 'shot_video' } },
    });

    const executorOpts = runExecutorMock.mock.calls[0]![0] as {
      target: { stage?: string };
    };
    // For shot_by_shot, stage='shot_video' is meaningful (gate the
    // per-shot FL2V path at that stage) — must NOT be rewritten.
    expect(executorOpts.target.stage).toBe('shot_video');
    expect(walkBundleMock).not.toHaveBeenCalled();
  });
});
