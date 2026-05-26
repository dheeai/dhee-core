/**
 * `ffmpeg.concat` runner — concatenates N input videos into one mp4.
 *
 * v1 uses the ffmpeg concat demuxer (no re-encode), which is the
 * fastest possible concat path when all inputs share the same codec,
 * resolution, and frame rate. The LTX Director workflow produces
 * consistent outputs so this works. If we later mix backends (LTX +
 * seedance) the runner can fall back to filter-based concat with a
 * single re-encode pass.
 *
 * Degenerate case (1 input) is handled — we just copy the file to the
 * goal path so the bundle's final_video node always produces an
 * artifact at its declared output location.
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';

interface FfmpegConcatConfig {
  /** Absolute paths to input mp4 files, in concat order. */
  inputs: string[];
  /** Output path relative to project dir. */
  outputPath: string;
}

function runFFmpeg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ ok: code === 0, stderr }));
    proc.on('error', (e) => resolve({ ok: false, stderr: `spawn failed: ${e.message}` }));
  });
}

async function runFfmpegConcat(ctx: RunnerContext): Promise<RunnerResult> {
  const cfg = ctx.node.runner.config as unknown as FfmpegConcatConfig;

  if (!cfg.inputs || cfg.inputs.length === 0) {
    return { ok: false, error: 'ffmpeg.concat: no inputs provided' };
  }
  if (!cfg.outputPath) {
    return { ok: false, error: 'ffmpeg.concat: missing outputPath' };
  }

  for (const p of cfg.inputs) {
    if (!existsSync(p)) {
      return { ok: false, error: `ffmpeg.concat: input not found: ${p}` };
    }
  }

  const outputAbs = join(ctx.projectDir, cfg.outputPath);
  mkdirSync(dirname(outputAbs), { recursive: true });

  if (cfg.inputs.length === 1) {
    ctx.log(`ffmpeg.concat: single input — copying to ${cfg.outputPath}`);
    copyFileSync(cfg.inputs[0]!, outputAbs);
    return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'copy', inputCount: 1 } };
  }

  // N>1 — use concat demuxer (no re-encode).
  const listFile = join(tmpdir(), `dag_concat_${Date.now()}.txt`);
  const listContent = cfg.inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(listFile, listContent);

  ctx.log(`ffmpeg.concat: concatenating ${cfg.inputs.length} clips → ${cfg.outputPath}`);
  const result = await runFFmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    outputAbs,
  ]);

  try { unlinkSync(listFile); } catch { /* ignore */ }

  if (!result.ok) {
    return { ok: false, error: `ffmpeg.concat: ffmpeg failed — ${result.stderr.slice(-500)}` };
  }

  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: { mode: 'concat_demuxer', inputCount: cfg.inputs.length },
  };
}

function describe(): RunnerDescription {
  return {
    id: 'ffmpeg.concat',
    displayName: 'FFmpeg concat',
    description: 'Concatenates N input videos into one mp4 using the ffmpeg concat demuxer (no re-encode).',
    capabilities: ['video_concat'],
    modalities: { input: ['video'], output: ['video'] },
    configSchema: {
      type: 'object',
      required: ['inputs', 'outputPath'],
      properties: {
        inputs: { type: 'array', items: { type: 'string' }, minItems: 1 },
        outputPath: { type: 'string' },
      },
    },
    costHint: 'free',
  };
}

export const ffmpegConcatRunner: Runner = { describe, run: runFfmpegConcat };
