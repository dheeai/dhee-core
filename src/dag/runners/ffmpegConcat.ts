/**
 * `ffmpeg.concat` runner — concatenates N input videos into one mp4 and
 * applies the dhee.studio watermark overlay.
 *
 * v1 strategy:
 *   1. Concat sources with the ffmpeg concat demuxer (`-c copy`, no
 *      re-encode) into a temp file. Fast when the sources already share
 *      codec/resolution/fps (true for all LTX Director outputs in this
 *      project).
 *   2. If a watermark PNG is found via `resolveWatermarkPath` and the
 *      override `dhee_WATERMARK=off` is not set, re-encode the temp
 *      through the watermark overlay filter into the final output.
 *      Otherwise rename the temp to the final.
 *
 * This restores the watermark presence on every assembled final video
 * — the previous (stripped) FFmpegAssembler path applied it, and the
 * v1 of this runner skipped it as a regression. Reuses the existing
 * `resolveWatermarkPath` + `buildWatermarkOverlayFilter` helpers so the
 * watermark sizing and placement stay identical (~9% of output height,
 * bottom-right with 24px inset).
 *
 * Degenerate case (1 input + no watermark) is still a copy. Single
 * input + watermark re-encodes once through the overlay filter.
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveWatermarkPath, buildWatermarkOverlayFilter } from '../../core/timeline/watermark.js';
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

function probeHeight(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=height',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const h = parseInt(out.trim(), 10);
      resolve(Number.isFinite(h) && h > 0 ? h : null);
    });
    proc.on('error', () => resolve(null));
  });
}

async function applyWatermark(
  ctx: RunnerContext,
  inputPath: string,
  outputPath: string,
  watermarkPath: string,
): Promise<{ ok: boolean; stderr?: string }> {
  const height = (await probeHeight(inputPath)) ?? 720;
  const filter = buildWatermarkOverlayFilter('0:v', 1, 'outv', height);
  ctx.log(`ffmpeg.concat: applying dhee watermark (output ${height}p) → ${outputPath}`);
  const result = await runFFmpeg([
    '-y',
    '-i', inputPath,
    '-i', watermarkPath,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '0:a?',          // pass-through audio if present
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ]);
  return result.ok ? { ok: true } : { ok: false, stderr: result.stderr };
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

  // Watermark resolution — same precedence as the legacy assembler.
  // dhee_WATERMARK=off disables; otherwise look for an asset.
  const watermarkDisabled = process.env['dhee_WATERMARK'] === 'off';
  const watermarkPath = watermarkDisabled ? null : resolveWatermarkPath();
  if (!watermarkPath && !watermarkDisabled) {
    ctx.log(`ffmpeg.concat: WARNING — no watermark asset found via resolveWatermarkPath (looked for assets/watermark_dhee.png, assets/watermark.png). Final video will ship un-branded.`);
  }

  // ── Single-input path ──
  if (cfg.inputs.length === 1) {
    if (!watermarkPath) {
      ctx.log(`ffmpeg.concat: single input + no watermark — copying`);
      copyFileSync(cfg.inputs[0]!, outputAbs);
      return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'copy', inputCount: 1, watermarked: false } };
    }
    const wm = await applyWatermark(ctx, cfg.inputs[0]!, outputAbs, watermarkPath);
    if (!wm.ok) return { ok: false, error: `ffmpeg.concat: watermark pass failed — ${(wm.stderr ?? '').slice(-500)}` };
    return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'watermark_reencode', inputCount: 1, watermarked: true } };
  }

  // ── N-input path: concat demuxer → temp → optional watermark pass ──
  const listFile = join(tmpdir(), `dag_concat_${Date.now()}.txt`);
  const listContent = cfg.inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(listFile, listContent);

  const concatTarget = watermarkPath ? `${outputAbs}.preview.tmp.mp4` : outputAbs;
  ctx.log(`ffmpeg.concat: concatenating ${cfg.inputs.length} clips → ${watermarkPath ? '<temp>' : cfg.outputPath}`);
  const concat = await runFFmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    concatTarget,
  ]);

  try { unlinkSync(listFile); } catch { /* ignore */ }

  if (!concat.ok) {
    try { if (existsSync(concatTarget)) unlinkSync(concatTarget); } catch { /* ignore */ }
    return { ok: false, error: `ffmpeg.concat: ffmpeg concat failed — ${concat.stderr.slice(-500)}` };
  }

  if (!watermarkPath) {
    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: { mode: 'concat_demuxer', inputCount: cfg.inputs.length, watermarked: false },
    };
  }

  // Apply watermark in a second pass over the temp.
  const wm = await applyWatermark(ctx, concatTarget, outputAbs, watermarkPath);
  try { unlinkSync(concatTarget); } catch { /* ignore */ }
  if (!wm.ok) {
    return { ok: false, error: `ffmpeg.concat: watermark pass failed — ${(wm.stderr ?? '').slice(-500)}` };
  }
  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: { mode: 'concat_demuxer+watermark', inputCount: cfg.inputs.length, watermarked: true },
  };
}

function describe(): RunnerDescription {
  return {
    id: 'ffmpeg.concat',
    displayName: 'FFmpeg concat + watermark',
    description: 'Concatenates N input videos into one mp4 (concat demuxer, no re-encode) and applies the dhee.studio watermark overlay in a second pass when an asset is present.',
    capabilities: ['video_concat', 'video_watermark'],
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
