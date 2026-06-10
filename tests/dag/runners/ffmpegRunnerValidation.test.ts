/**
 * ffmpeg.concat + ffmpeg.shot_clip — describe() metadata and the
 * deterministic EARLY-VALIDATION branches that return BEFORE any ffmpeg
 * process is spawned. We never spawn ffmpeg here (no real binary, no
 * filtergraph execution); we only assert the pure config/input guards
 * and the runner descriptions.
 *
 * The filtergraph / arg-list construction (buildFilterComplex,
 * paletteForStyle, the concat-list escaping) is NOT exported and is only
 * reachable past a spawn, so it is exercised by the e2e suite, not here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ffmpegConcatRunner } from '../../../src/dag/runners/ffmpegConcat.js';
import { ffmpegShotClipRunner } from '../../../src/dag/runners/ffmpegShotClip.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ffmpeg-val-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(
  tool: string,
  config: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  nodeInputs: NodeDef['inputs'] = [],
): RunnerContext {
  const node: NodeDef = {
    id: 'final_video',
    kind: 'stage',
    inputs: nodeInputs,
    outputs: { format: 'video', pattern: 'out.mp4' },
    runner: { tool, config },
  };
  return { projectDir, node, inputs, log: () => {} } as RunnerContext;
}

describe('ffmpeg.concat — early validation (no spawn)', () => {
  it('fails when no inputs are provided and ctx.inputs has no videos', async () => {
    const r = await ffmpegConcatRunner.run(makeCtx('ffmpeg.concat', { outputPath: 'out.mp4', inputs: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no inputs provided/);
  });

  it('fails when outputPath is missing but inputs exist', async () => {
    const a = join(projectDir, 'a.mp4');
    writeFileSync(a, Buffer.from('x'));
    const r = await ffmpegConcatRunner.run(makeCtx('ffmpeg.concat', { inputs: [a] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing outputPath/);
  });

  it('fails when a declared input file does not exist', async () => {
    const r = await ffmpegConcatRunner.run(
      makeCtx('ffmpeg.concat', { inputs: [join(projectDir, 'nope.mp4')], outputPath: 'out.mp4' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/input not found/);
  });

  it('auto-discovery: ignores non-video / non-existent ctx.inputs and still fails with no inputs', async () => {
    // ctx.inputs has a string that is not a video path → not discovered.
    const r = await ffmpegConcatRunner.run(
      makeCtx(
        'ffmpeg.concat',
        { outputPath: 'out.mp4' },
        { shot_1_video: 'not-a-path', some_text: 'hello' },
        [{ from: 'shot_1_video', usage: 'input' }, { from: 'some_text', usage: 'input' }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no inputs provided/);
  });
});

describe('ffmpeg.concat — describe()', () => {
  it('reports id, capabilities, modalities and free cost', () => {
    const d = ffmpegConcatRunner.describe();
    expect(d.id).toBe('ffmpeg.concat');
    expect(d.capabilities).toEqual(['video_concat', 'video_watermark']);
    expect(d.modalities).toEqual({ input: ['video'], output: ['video'] });
    expect(d.costHint).toBe('free');
    expect(d.configSchema?.required).toEqual(['inputs', 'outputPath']);
  });
});

describe('ffmpeg.shot_clip — early validation (no spawn)', () => {
  const breakdown = { shots: [{ shotNumber: 1, durationSec: 8, imagePrompt: 'a street' }] };

  it('fails when shotNumber is missing', async () => {
    const r = await ffmpegShotClipRunner.run(
      makeCtx('ffmpeg.shot_clip', { outputPath: 'out.mp4' }, { shot_breakdown: breakdown }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing required config field shotNumber/);
  });

  it('fails when outputPath is missing', async () => {
    const r = await ffmpegShotClipRunner.run(
      makeCtx('ffmpeg.shot_clip', { shotNumber: 1 }, { shot_breakdown: breakdown }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing outputPath/);
  });

  it('fails when shot_breakdown input is absent', async () => {
    const r = await ffmpegShotClipRunner.run(
      makeCtx('ffmpeg.shot_clip', { shotNumber: 1, outputPath: 'out.mp4' }, {}),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing shot_breakdown input/);
  });

  it('fails when shot_breakdown is not an object', async () => {
    const r = await ffmpegShotClipRunner.run(
      makeCtx('ffmpeg.shot_clip', { shotNumber: 1, outputPath: 'out.mp4' }, { shot_breakdown: 'nope' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing shot_breakdown input/);
  });

  it('fails when the requested shotNumber is not in shot_breakdown.shots[]', async () => {
    const r = await ffmpegShotClipRunner.run(
      makeCtx('ffmpeg.shot_clip', { shotNumber: 99, outputPath: 'out.mp4' }, { shot_breakdown: breakdown }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/has no shotNumber=99/);
  });
});

describe('ffmpeg.shot_clip — describe()', () => {
  it('reports id, video output modality and required config', () => {
    const d = ffmpegShotClipRunner.describe();
    expect(d.id).toBe('ffmpeg.shot_clip');
    expect(d.modalities?.output).toEqual(['video']);
    expect(d.configSchema?.required).toEqual(['shotNumber', 'outputPath']);
  });
});
