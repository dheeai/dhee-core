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
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
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
  /**
   * Optional absolute path to an SRT file. When set, ffmpeg burns the
   * subtitles into the final output during the re-encode pass.
   */
  subtitlesPath?: string;
}

// Cached at module load — checked once per process.
let drawtextAvailable: boolean | null = null;
function hasDrawtextFilter(): Promise<boolean> {
  if (drawtextAvailable !== null) return Promise.resolve(drawtextAvailable);
  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin(), ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout?.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      drawtextAvailable = /\bdrawtext\b/.test(out);
      resolve(drawtextAvailable);
    });
    proc.on('error', () => { drawtextAvailable = false; resolve(false); });
  });
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

interface SrtCue { start: number; end: number; text: string }

function parseSrtTime(s: string): number {
  // "HH:MM:SS,mmm" → seconds (float)
  const m = s.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!m) return 0;
  return parseInt(m[1]!, 10) * 3600 + parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10) + parseInt(m[4]!, 10) / 1000;
}

function parseSrt(srtText: string): SrtCue[] {
  const cues: SrtCue[] = [];
  // Split on blank lines (handle Windows + Unix line endings).
  const blocks = srtText.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    // lines[0] = index, lines[1] = "start --> end", lines[2..] = text
    const timeLine = lines[1] ?? '';
    const m = timeLine.match(/^(\S+)\s*-->\s*(\S+)/);
    if (!m) continue;
    const start = parseSrtTime(m[1]!);
    const end = parseSrtTime(m[2]!);
    const text = lines.slice(2).join(' ');
    if (text.length > 0) cues.push({ start, end, text });
  }
  return cues;
}

function escapeForDrawtext(s: string): string {
  // ffmpeg drawtext text=... needs colons, single quotes, backslashes, and
  // percent escaped. Order matters: backslash first.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

function buildDrawtextChain(cues: SrtCue[], inLabel: string, outLabel: string): string {
  // One drawtext per cue, chained with commas. Each cue is gated by
  // `enable='between(t,start,end)'` so only the active cue draws. We use
  // a fixed font size (24), bottom-centered with a translucent box.
  // Font: 'Helvetica' is a system font on macOS; ffmpeg falls back to a
  // default if unavailable. To be portable across OSes we omit fontfile
  // and rely on the default font (which works without a Linux fontconfig).
  const drawSpecs = cues.map((c) => {
    const text = escapeForDrawtext(c.text);
    return [
      `drawtext=text='${text}'`,
      `enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'`,
      `x=(w-text_w)/2`,
      `y=h-(text_h*2)-20`,
      `fontsize=22`,
      `fontcolor=white`,
      `box=1`,
      `boxcolor=black@0.55`,
      `boxborderw=12`,
    ].join(':');
  });
  return `[${inLabel}]${drawSpecs.join(',')}[${outLabel}]`;
}

async function reencodePass(
  ctx: RunnerContext,
  inputPath: string,
  outputPath: string,
  watermarkPath: string | null,
  subtitlesPath: string | null,
): Promise<{ ok: boolean; stderr?: string }> {
  const height = (await probeHeight(inputPath)) ?? 720;
  const args: string[] = ['-y', '-i', inputPath];
  if (watermarkPath) args.push('-i', watermarkPath);

  // Parse the SRT into cues and burn captions in via the drawtext filter.
  // Pre-flight drawtext capability check happens in runFfmpegConcat, so
  // a non-null subtitlesPath here means we already confirmed drawtext is
  // available (the runner nulls it out on incompatible builds).
  const cues: SrtCue[] = subtitlesPath ? parseSrt(readFileSync(subtitlesPath, 'utf-8')) : [];

  // Build filter chain. Start from 0:v. If captions are requested, draw
  // them in via the drawtext chain to produce [withsubs]. Then either
  // overlay the watermark from input 1 onto that, or pass through.
  const chains: string[] = [];
  let lastLabel = '0:v';
  if (cues.length > 0) {
    chains.push(buildDrawtextChain(cues, lastLabel, 'withsubs'));
    lastLabel = 'withsubs';
  }
  if (watermarkPath) {
    chains.push(buildWatermarkOverlayFilter(lastLabel, 1, 'outv', height));
    lastLabel = 'outv';
  }

  const tag: string[] = [];
  if (subtitlesPath) tag.push('subtitles');
  if (watermarkPath) tag.push('watermark');
  ctx.log(`ffmpeg.concat: re-encode pass (${tag.join('+') || 'copy'}, output ${height}p) → ${outputPath}`);

  if (chains.length > 0) {
    args.push('-filter_complex', chains.join(';'), '-map', `[${lastLabel}]`);
  } else {
    args.push('-map', '0:v');
  }
  args.push(
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  );

  const result = await runFFmpeg(args);
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

  let subtitlesPath: string | null = cfg.subtitlesPath && existsSync(cfg.subtitlesPath) ? cfg.subtitlesPath : null;
  if (cfg.subtitlesPath && !subtitlesPath) {
    ctx.log(`ffmpeg.concat: WARNING — subtitlesPath ${cfg.subtitlesPath} not found, skipping subtitle burn-in`);
  }
  // If subtitles requested but ffmpeg lacks the drawtext filter, drop the
  // subtitle path here so we don't enter the re-encode branch unnecessarily.
  // SRT sidecar still exists for external use.
  if (subtitlesPath) {
    const canDrawtext = await hasDrawtextFilter();
    if (!canDrawtext) {
      ctx.log(
        `ffmpeg.concat: WARNING — installed ffmpeg lacks the drawtext filter ` +
        `(no libfreetype in build). Skipping subtitle burn-in. ` +
        `SRT sidecar still produced at ${subtitlesPath}. ` +
        `Reinstall ffmpeg with libfreetype (e.g. brew install ` +
        `homebrew-ffmpeg/ffmpeg/ffmpeg) for in-video captions.`,
      );
      subtitlesPath = null;
    }
  }
  const needsReencode = !!(watermarkPath || subtitlesPath);

  // ── Single-input path ──
  if (cfg.inputs.length === 1) {
    if (!needsReencode) {
      ctx.log(`ffmpeg.concat: single input + no watermark/subtitles — copying`);
      copyFileSync(cfg.inputs[0]!, outputAbs);
      return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'copy', inputCount: 1, watermarked: false, subtitled: false } };
    }
    const r = await reencodePass(ctx, cfg.inputs[0]!, outputAbs, watermarkPath, subtitlesPath);
    if (!r.ok) return { ok: false, error: `ffmpeg.concat: re-encode pass failed — ${(r.stderr ?? '').slice(-500)}` };
    return { ok: true, outputPath: cfg.outputPath, metadata: { mode: 'reencode', inputCount: 1, watermarked: !!watermarkPath, subtitled: !!subtitlesPath } };
  }

  // ── N-input path: concat demuxer → temp → optional re-encode pass ──
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
      metadata: { mode: 'concat_demuxer', inputCount: cfg.inputs.length, watermarked: false, subtitled: false },
    };
  }

  const r = await reencodePass(ctx, concatTarget, outputAbs, watermarkPath, subtitlesPath);
  try { unlinkSync(concatTarget); } catch { /* ignore */ }
  if (!r.ok) {
    return { ok: false, error: `ffmpeg.concat: re-encode pass failed — ${(r.stderr ?? '').slice(-500)}` };
  }
  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: { mode: 'concat_demuxer+reencode', inputCount: cfg.inputs.length, watermarked: !!watermarkPath, subtitled: !!subtitlesPath },
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
        subtitlesPath: { type: 'string', description: 'Optional absolute path to an SRT file to burn into the final output.' },
      },
    },
    costHint: 'free',
  };
}

export const ffmpegConcatRunner: Runner = { describe, run: runFfmpegConcat };
