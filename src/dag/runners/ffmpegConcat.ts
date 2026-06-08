/**
 * `ffmpeg.concat` runner — concatenates N input videos into one mp4 and
 * applies the dhee.studio watermark overlay.
 *
 * Strategy:
 *   1. Concat sources with the ffmpeg concat demuxer (`-c copy`, no
 *      re-encode) into a temp file. Fast when the sources already share
 *      codec/resolution/fps (true for all LTX Director outputs).
 *   2. If a watermark PNG is found via `resolveWatermarkPath` and the
 *      override `dhee_WATERMARK=off` is not set, re-encode the temp
 *      through the watermark overlay filter into the final output.
 *      Otherwise the concat output IS the final.
 *
 * Subtitle burn-in was REMOVED. It was the only fragile step in the
 * re-encode pass — drawtext needs a system font and careful filtergraph
 * escaping, and when it failed it took the WATERMARK down with it (the
 * watermark + captions shared one re-encode pass), so the final video
 * shipped un-branded. No product feature consumes burned-in captions.
 * The walker still writes the SRT sidecar (assets/subtitles/final.srt)
 * for external players; this runner no longer touches subtitles, so the
 * watermark can never again be collateral damage from a caption failure.
 *
 * Degenerate case (1 input + no watermark) is a copy. Single input +
 * watermark re-encodes once through the overlay filter.
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ffmpegBin, ffprobeBin } from './ffmpegBin.js';
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
    const proc = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ ok: code === 0, stderr }));
    proc.on('error', (e) => resolve({ ok: false, stderr: `spawn failed: ${e.message}` }));
  });
}

function probeHeight(inputPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin(), [
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

/**
 * Read the watermark opacity (0..1) from `dhee_WATERMARK_OPACITY`.
 * Returns undefined when unset / unparseable / out of range so the
 * overlay helper applies its own default (0.8).
 */
function resolveWatermarkOpacity(): number | undefined {
  const raw = process.env['dhee_WATERMARK_OPACITY'];
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

async function reencodePass(
  ctx: RunnerContext,
  inputPath: string,
  outputPath: string,
  watermarkPath: string,
): Promise<{ ok: boolean; stderr?: string }> {
  const height = (await probeHeight(inputPath)) ?? 720;
  const filter = buildWatermarkOverlayFilter('0:v', 1, 'outv', height, resolveWatermarkOpacity());
  ctx.log(`ffmpeg.concat: watermark re-encode pass (output ${height}p) → ${outputPath}`);
  const result = await runFFmpeg([
    '-y',
    '-i', inputPath,
    '-i', watermarkPath,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '0:a?',
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

  // Auto-discover inputs from ctx.inputs when the bundle hasn't
  // pre-resolved them in cfg.inputs. The walker exposes binary
  // upstream artifacts as absolute paths keyed by upstream node id
  // (see walker.ts ~L1185 isBinary branch), so we sweep ctx.inputs in
  // ctx.node.inputs declaration order and pick the entries whose
  // value is a path to an existing video file. This lets bundles wire
  // up `final_video` with explicit `inputs: [{from:'shot_1_video'},...]`
  // without duplicating the path list into cfg.inputs.
  if (!cfg.inputs || cfg.inputs.length === 0) {
    const discovered: string[] = [];
    const videoRe = /\.(mp4|webm|mov)$/i;
    for (const decl of ctx.node.inputs ?? []) {
      const v = ctx.inputs[decl.from];
      if (typeof v === 'string' && videoRe.test(v) && existsSync(v)) {
        discovered.push(v);
      }
    }
    if (discovered.length > 0) {
      ctx.log(`ffmpeg.concat: auto-discovered ${discovered.length} input video(s) from ctx.inputs`);
      cfg.inputs = discovered;
    }
  }
  if (!cfg.inputs || cfg.inputs.length === 0) {
    return { ok: false, error: 'ffmpeg.concat: no inputs provided (cfg.inputs empty AND no binary inputs in ctx.inputs)' };
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
  const needsReencode = !!watermarkPath;

  // ── Single-input path ──
  if (cfg.inputs.length === 1) {
    if (!needsReencode) {
      ctx.log(`ffmpeg.concat: single input + no watermark — copying`);
      copyFileSync(cfg.inputs[0]!, outputAbs);
      return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'copy', inputCount: 1, watermarked: false } };
    }
    const r = await reencodePass(ctx, cfg.inputs[0]!, outputAbs, watermarkPath!);
    if (!r.ok) return { ok: false, error: `ffmpeg.concat: re-encode pass failed — ${(r.stderr ?? '').slice(-500)}` };
    return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'reencode', inputCount: 1, watermarked: true } };
  }

  // ── N-input path: concat demuxer → temp → optional watermark pass ──
  const listFile = join(tmpdir(), `dag_concat_${Date.now()}.txt`);
  const listContent = cfg.inputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  writeFileSync(listFile, listContent);

  const concatTarget = needsReencode ? `${outputAbs}.preview.tmp.mp4` : outputAbs;
  ctx.log(`ffmpeg.concat: concatenating ${cfg.inputs.length} clips → ${needsReencode ? '<temp>' : cfg.outputPath}`);
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

  if (!needsReencode) {
    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: { mode: 'concat_demuxer', inputCount: cfg.inputs.length, watermarked: false },
    };
  }

  const r = await reencodePass(ctx, concatTarget, outputAbs, watermarkPath!);
  try { unlinkSync(concatTarget); } catch { /* ignore */ }
  if (!r.ok) {
    return { ok: false, error: `ffmpeg.concat: re-encode pass failed — ${(r.stderr ?? '').slice(-500)}` };
  }
  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: { mode: 'concat_demuxer+reencode', inputCount: cfg.inputs.length, watermarked: true },
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
