/**
 * `ffmpeg.shot_clip` — synthesize a 10s MP4 clip for one shot from a
 * shot_breakdown.json entry. This is a STAND-IN for the real LTX
 * video runner; it produces a real, playable MP4 so end-to-end
 * tests can flow actual binary artifacts through events + CAS +
 * branches without requiring GPU / Comfy / LTX.
 *
 * The clip is intentionally simple — animated colored boxes over a
 * tinted background, with the tint derived from the shot's style.
 * Each shot has a distinct visual palette so the 3-shot final cut
 * is visibly a "story" rather than three identical clips.
 *
 *   - cinematic_realism style → warm amber palette
 *   - noir style              → cool blue, high contrast
 *   - default                 → neutral grey
 *
 * No text rendering — this ffmpeg build lacks drawtext. The dialogue
 * lines live in shot_breakdown.json which downstream tools (real
 * LTX runner, desktop preview) consume.
 *
 * Config:
 *   - shotNumber (required): which shot from shot_breakdown.shots[] to render
 *   - durationSec (optional): clip length, default 10
 *   - width / height (optional): default 1280x720
 *   - fps (optional): default 30
 *   - outputPath (required): set by the walker from node.outputs.pattern
 *
 * The runner reads its style from the shot_breakdown's enclosing
 * config (the calling bundle passes a `style` bundle input that
 * shows up in ctx.inputs).
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { ffmpegBin } from './ffmpegBin.js';

import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { openGenerationCache } from '../cas/GenerationCache.js';
import type { InputsHashKey } from '../cas/inputsHash.js';
import { getProjectCacheScope } from '../projectIdentity.js';

interface FfmpegShotClipConfig {
  shotNumber: number;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  outputPath: string;
  forceRerun?: boolean;
}

interface ShotEntry {
  shotNumber: number;
  durationSec?: number;
  imagePrompt?: string;
  motionDirective?: string;
  dialogueLine?: string;
}

export interface PaletteEntry {
  bg: string;       // hex like 0x123456
  fgA: string;
  fgB: string;
}

export function paletteForStyle(style: string): PaletteEntry {
  const s = style.toLowerCase();
  if (s.includes('noir')) {
    return { bg: '0x0c1320', fgA: '0xc0c5d4', fgB: '0x47506a' };
  }
  if (s.includes('anime') || s.includes('animation')) {
    return { bg: '0x18406b', fgA: '0xffd166', fgB: '0xef476f' };
  }
  // cinematic_realism (default warm)
  return { bg: '0x402611', fgA: '0xf2c97a', fgB: '0xa3553b' };
}

function runFFmpeg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolveDone) => {
    const proc = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolveDone({ ok: code === 0, stderr }));
    proc.on('error', (e) => resolveDone({ ok: false, stderr: `spawn failed: ${e.message}` }));
  });
}

/**
 * Build the filter_complex for a 10s clip. We use only filters that
 * Homebrew's default ffmpeg ships — no drawtext, no special codecs.
 *
 * Layout per shot index (chosen to look visually different so a
 * concatenated 30s file reads as a sequence rather than one looping
 * frame):
 *
 *   - shot 1 (early/setup): a tall left box that slowly sways right
 *   - shot 2 (turning point): two side-by-side boxes (one taller, one
 *     wider) that breathe in/out as if conversation tension
 *   - shot 3 (resolution): a single centered box with a horizontal
 *     gradient sweep (sunrise feel)
 */
export function buildFilterComplex(shot: number, palette: PaletteEntry, width: number, height: number, duration: number): string {
  const bg = `color=c=${palette.bg}:size=${width}x${height}:duration=${duration}:rate=30`;

  const fgABoxW = Math.floor(width * 0.18);
  const fgABoxH = Math.floor(height * 0.55);
  const fgBBoxW = Math.floor(width * 0.22);
  const fgBBoxH = Math.floor(height * 0.50);

  // 1-indexed shot picks one of three motion presets.
  if (shot === 1) {
    // One large box, slowly drifting right
    return (
      `[0:v]drawbox=x='${Math.floor(width * 0.15)}+(t/${duration})*${Math.floor(width * 0.05)}':` +
      `y='${Math.floor(height * 0.20)}':w=${fgABoxW}:h=${fgABoxH}:color=${palette.fgA}@0.85:t=fill,` +
      `drawbox=x='${Math.floor(width * 0.65)}':y='${Math.floor(height * 0.55)}':w=${Math.floor(width * 0.12)}:h=${Math.floor(height * 0.20)}:color=${palette.fgB}@0.7:t=fill,format=yuv420p`
    );
  }
  if (shot === 2) {
    // Two boxes, breathing
    return (
      `[0:v]drawbox=x='${Math.floor(width * 0.20)}-sin(t*0.6)*8':` +
      `y='${Math.floor(height * 0.25)}':w='${fgABoxW}+sin(t*0.5)*${Math.floor(fgABoxW * 0.05)}':h=${fgABoxH}:color=${palette.fgA}@0.85:t=fill,` +
      `drawbox=x='${Math.floor(width * 0.55)}+cos(t*0.4)*8':y='${Math.floor(height * 0.30)}':w=${fgBBoxW}:h='${fgBBoxH}+sin(t*0.6)*${Math.floor(fgBBoxH * 0.05)}':color=${palette.fgB}@0.85:t=fill,format=yuv420p`
    );
  }
  // shot 3: centered box + horizontal sunrise sweep (a bright band that
  //         crosses the frame over the duration).
  const sweepW = Math.floor(width * 0.10);
  return (
    `[0:v]drawbox=x='${Math.floor(width * 0.42)}':y='${Math.floor(height * 0.22)}':w=${fgABoxW}:h=${fgABoxH}:color=${palette.fgA}@0.9:t=fill,` +
    `drawbox=x='(t/${duration})*${width - sweepW}':y=0:w=${sweepW}:h=${height}:color=${palette.fgB}@0.35:t=fill,format=yuv420p`
  );
}

export function createFfmpegShotClipRunner(): Runner {
  const describe = (): RunnerDescription => ({
    id: 'ffmpeg.shot_clip',
    displayName: 'FFmpeg Shot Clip',
    description: 'Synthesizes a 10s MP4 for one shot. Stand-in for the real LTX video runner — produces real binary artifacts without needing GPU.',
    capabilities: ['video-synthesis-stub'],
    modalities: { input: ['text'], output: ['video'] },
    configSchema: {
      type: 'object',
      required: ['shotNumber', 'outputPath'],
      properties: {
        shotNumber:  { type: 'integer' },
        durationSec: { type: 'integer' },
        width:       { type: 'integer' },
        height:      { type: 'integer' },
        fps:         { type: 'integer' },
        outputPath:  { type: 'string' },
        forceRerun:  { type: 'boolean' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as unknown as FfmpegShotClipConfig;
    if (!cfg.shotNumber) {
      return { ok: false, error: 'ffmpeg.shot_clip: missing required config field shotNumber' };
    }
    if (!cfg.outputPath) {
      return { ok: false, error: 'ffmpeg.shot_clip: missing outputPath (walker should populate this from node.outputs.pattern)' };
    }

    const breakdownInput = ctx.inputs['shot_breakdown'];
    if (!breakdownInput || typeof breakdownInput !== 'object') {
      return { ok: false, error: 'ffmpeg.shot_clip: missing shot_breakdown input (expect parsed JSON)' };
    }
    const breakdown = breakdownInput as { shots?: ShotEntry[] };
    const shot = breakdown.shots?.find((s) => s.shotNumber === cfg.shotNumber);
    if (!shot) {
      return { ok: false, error: `ffmpeg.shot_clip: shot_breakdown.shots[] has no shotNumber=${cfg.shotNumber}` };
    }

    const style = (ctx.inputs['style'] as string) ?? 'cinematic_realism';
    const palette = paletteForStyle(style);
    const width = cfg.width ?? 1280;
    const height = cfg.height ?? 720;
    const duration = cfg.durationSec ?? shot.durationSec ?? 10;

    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    mkdirSync(dirname(outAbs), { recursive: true });

    // CAS: same key shape as llm.generate uses. Identical (shot data,
    // style, dimensions) across projects/branches replays from CAS.
    const cacheKey: InputsHashKey = {
      tool: 'ffmpeg.shot_clip',
      toolVersion: '0.1.0',
      inputs: { shot, style },
      config: {
        projectScope: getProjectCacheScope(ctx.projectDir),
        width,
        height,
        duration,
        shotNumber: cfg.shotNumber,
      },
    };
    const casDisabled = process.env['DHEE_DISABLE_CAS'] === '1';
    if (!casDisabled && !cfg.forceRerun) {
      const cache = openGenerationCache(
        process.env['DHEE_CACHE_ROOT'] ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] } : undefined,
      );
      const hit = cache.get(cacheKey);
      if (hit) {
        copyFileSync(hit.storePath, outAbs);
        ctx.log(`ffmpeg.shot_clip: CAS hit ${hit.hash.slice(0, 8)} → ${cfg.outputPath}`);
        return {
          ok: true,
          outputPath: cfg.outputPath,
          metadata: { cached: true, inputsHash: hit.hash, casHit: true, shotNumber: cfg.shotNumber },
        };
      }
    }

    // Path-based skip ONLY when CAS is disabled — otherwise CAS is
    // the source of truth for "have we computed this before". A
    // path-based skip after a CAS miss would serve a file produced
    // with DIFFERENT inputs (e.g. from another branch).
    if (casDisabled && !cfg.forceRerun && existsSync(outAbs)) {
      try {
        const st = statSync(outAbs);
        if (st.size > 0) {
          ctx.log(`ffmpeg.shot_clip: path-cached → ${cfg.outputPath}`);
          return { ok: true, outputPath: cfg.outputPath, metadata: { cached: true } };
        }
      } catch { /* fall through */ }
    }

    const filterComplex = buildFilterComplex(cfg.shotNumber, palette, width, height, duration);
    const bgInput = `color=c=${palette.bg}:size=${width}x${height}:duration=${duration}:rate=30`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', bgInput,
      '-filter_complex', filterComplex,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-t', String(duration),
      outAbs,
    ];

    ctx.log(`ffmpeg.shot_clip: rendering shot ${cfg.shotNumber} (style=${style}, ${width}x${height}, ${duration}s)`);
    const r = await runFFmpeg(args);
    if (!r.ok) {
      return { ok: false, error: `ffmpeg.shot_clip: ffmpeg failed: ${r.stderr.split('\n').slice(-3).join('\n')}` };
    }
    if (!existsSync(outAbs) || statSync(outAbs).size === 0) {
      return { ok: false, error: `ffmpeg.shot_clip: ffmpeg reported success but ${outAbs} is missing or empty` };
    }
    const bytes = statSync(outAbs).size;
    ctx.log(`ffmpeg.shot_clip: wrote ${cfg.outputPath} (${bytes} bytes)`);

    let inputsHashForEvent: string | undefined;
    if (!casDisabled) {
      try {
        const cache = openGenerationCache(
          process.env['DHEE_CACHE_ROOT'] ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] } : undefined,
        );
        const put = cache.put({ key: cacheKey, sourcePath: outAbs, ext: 'mp4', metadata: { shotNumber: cfg.shotNumber, style, bytes } });
        inputsHashForEvent = put.hash;
      } catch { /* best-effort */ }
    }

    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: {
        cached: false,
        shotNumber: cfg.shotNumber,
        bytes,
        ...(inputsHashForEvent ? { inputsHash: inputsHashForEvent } : {}),
      },
    };
  }

  return { describe, run };
}

export const ffmpegShotClipRunner = createFfmpegShotClipRunner();
