/**
 * `ffmpeg.kenburns` — animate ONE still image into a clip with a subtle
 * Ken Burns move (slow zoom / pan), optionally muxing a narration audio track
 * and sizing the clip to that audio's duration.
 *
 * Why this exists: generative video (LTX) mangles crisp infographic text and
 * charts. For text-heavy stills (infographics, slides, title cards) a pixel-
 * exact Ken Burns move keeps everything razor sharp while still adding life.
 *
 * Config:
 *   - imageInput (string): input id holding THIS item's still-image path.
 *       Falls back to the first image path found in ctx.inputs.
 *   - audioInput (string, optional): input id holding the narration audio path.
 *       When present the clip is sized to the audio and the audio is muxed in.
 *   - duration (number, optional): clip length (s) when there's no audio. Default 6.
 *   - motion (string, optional): 'in' | 'out' | 'left' | 'right' | 'up' | 'down'.
 *       Default 'in'. If unset, alternates by item index for variety.
 *   - zoom (number, optional): max zoom factor for in/out. Default 1.10.
 *   - fps (number, optional): default 30.
 *   - width / height (number, optional): output size. Default 1280x720.
 *   - outputPath (string): set by the walker from node.outputs.pattern.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ffmpegBin, ffprobeBin } from './ffmpegBin.js';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';

interface KenBurnsConfig {
  imageInput?: string;
  audioInput?: string;
  duration?: number;
  motion?: 'in' | 'out' | 'left' | 'right' | 'up' | 'down';
  zoom?: number;
  fps?: number;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain';
  padColor?: string;
  outputPath?: string;
  forceRerun?: boolean;
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

function mediaDurationSeconds(path: string): number | null {
  try {
    const out = execFileSync(
      ffprobeBin(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { encoding: 'utf-8' },
    ).trim();
    const d = parseFloat(out);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

function firstImagePath(ctx: RunnerContext, preferKey?: string): string | undefined {
  if (preferKey) {
    const v = ctx.inputs[preferKey];
    if (typeof v === 'string' && /\.(png|jpe?g|webp)$/i.test(v)) return v;
  }
  for (const decl of ctx.node.inputs ?? []) {
    const v = ctx.inputs[decl.from];
    if (typeof v === 'string' && /\.(png|jpe?g|webp)$/i.test(v) && existsSync(v)) return v;
  }
  for (const v of Object.values(ctx.inputs)) {
    if (typeof v === 'string' && /\.(png|jpe?g|webp)$/i.test(v) && existsSync(v)) return v;
  }
  return undefined;
}

/** Build the Ken Burns zoompan filter. Upscales the still well above the output
 *  size first (the classic zoompan anti-jitter trick), pans/zooms, then renders
 *  at the output resolution — so text stays sharp and the move is smooth. */
export function buildKenBurnsFilter(opts: {
  motion: NonNullable<KenBurnsConfig['motion']>;
  zoom: number;
  totalFrames: number;
  fps: number;
  width: number;
  height: number;
  /** 'cover' (default) scales+crops to fill — best for photos. 'contain'
   *  scales to FIT and pads, so a mismatched-aspect still (e.g. a landscape
   *  screenshot in a 9:16 frame) is shown WHOLE with letterbox bars — nothing
   *  cropped, pixel-exact. */
  fit?: 'cover' | 'contain';
  /** Pad/letterbox colour for fit:'contain'. Default near-black. */
  padColor?: string;
}): string {
  const { motion, zoom, totalFrames, fps, width, height } = opts;
  const fit = opts.fit ?? 'cover';
  const padColor = opts.padColor ?? '0x111319';
  const sw = width * 4;
  const sh = height * 4;
  // Per-frame zoom increment to reach `zoom` over the clip.
  const inc = (zoom - 1) / Math.max(1, totalFrames);
  const zIn = `min(zoom+${inc.toFixed(6)},${zoom})`;
  const zOut = `if(eq(on,0),${zoom},max(zoom-${inc.toFixed(6)},1.0))`;
  // Center expressions for x/y.
  const cx = `iw/2-(iw/zoom/2)`;
  const cy = `ih/2-(ih/zoom/2)`;
  // Pan expressions (constant slight zoom, moving window).
  const panZoom = ((1 + zoom) / 2).toFixed(4); // hold a mid zoom while panning
  let z = zIn;
  let x = cx;
  let y = cy;
  switch (motion) {
    case 'out': z = zOut; break;
    case 'left':  z = panZoom; x = `(iw-iw/zoom)*(1-on/${totalFrames})`; y = cy; break;
    case 'right': z = panZoom; x = `(iw-iw/zoom)*(on/${totalFrames})`;   y = cy; break;
    case 'up':    z = panZoom; y = `(ih-ih/zoom)*(1-on/${totalFrames})`; x = cx; break;
    case 'down':  z = panZoom; y = `(ih-ih/zoom)*(on/${totalFrames})`;   x = cx; break;
    case 'in':
    default: break;
  }
  const fitChain =
    fit === 'contain'
      ? `scale=${sw}:${sh}:force_original_aspect_ratio=decrease,pad=${sw}:${sh}:(${sw}-iw)/2:(${sh}-ih)/2:${padColor}`
      : `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh}`;
  return (
    `${fitChain},` +
    `zoompan=z='${z}':d=${totalFrames}:x='${x}':y='${y}':s=${width}x${height}:fps=${fps},` +
    `format=yuv420p`
  );
}

const MOTION_CYCLE: NonNullable<KenBurnsConfig['motion']>[] = ['in', 'left', 'out', 'right', 'in', 'up'];

function motionForItem(ctx: RunnerContext): NonNullable<KenBurnsConfig['motion']> {
  // Stable per-item variety from the item id (no Math.random).
  const id = ctx.itemId ?? '';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return MOTION_CYCLE[h % MOTION_CYCLE.length]!;
}

export function createFfmpegKenBurnsRunner(): Runner {
  const describe = (): RunnerDescription => ({
    id: 'ffmpeg.kenburns',
    displayName: 'FFmpeg Ken Burns',
    description: 'Animates one still image with a subtle Ken Burns zoom/pan and muxes narration audio, sized to that audio. Keeps text-heavy stills (infographics, slides) pixel-sharp — unlike generative video.',
    capabilities: ['video-synthesis', 'ken-burns', 'audio-mux'],
    modalities: { input: ['image', 'audio'], output: ['video'] },
    configSchema: {
      type: 'object',
      required: ['outputPath'],
      properties: {
        imageInput: { type: 'string' },
        audioInput: { type: 'string' },
        duration: { type: 'number' },
        motion: { type: 'string', enum: ['in', 'out', 'left', 'right', 'up', 'down'] },
        zoom: { type: 'number' },
        fps: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        outputPath: { type: 'string' },
        forceRerun: { type: 'boolean' },
      },
    },
    costHint: 'free',
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as unknown as KenBurnsConfig;
    if (!cfg.outputPath) return { ok: false, error: 'ffmpeg.kenburns: missing outputPath' };

    const imagePath = firstImagePath(ctx, cfg.imageInput);
    if (!imagePath) {
      return { ok: false, error: `ffmpeg.kenburns: no image path resolved (imageInput='${cfg.imageInput ?? ''}')` };
    }

    const fps = cfg.fps ?? 30;
    const width = cfg.width ?? 1280;
    const height = cfg.height ?? 720;
    const zoom = cfg.zoom ?? 1.10;
    const motion = cfg.motion ?? motionForItem(ctx);

    // Audio (optional) → sizes the clip + gets muxed.
    let audioPath: string | undefined;
    if (cfg.audioInput) {
      const a = ctx.inputs[cfg.audioInput];
      if (typeof a === 'string' && existsSync(a)) audioPath = a;
    }
    let duration = cfg.duration ?? 6;
    if (audioPath) {
      const d = mediaDurationSeconds(audioPath);
      if (d && d > 0) duration = d;
    }
    const totalFrames = Math.max(2, Math.round(duration * fps));

    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    mkdirSync(dirname(outAbs), { recursive: true });

    if (!cfg.forceRerun && existsSync(outAbs) && statSync(outAbs).size > 0 && !process.env['DAG_BUNDLE_FORCE_RERENDER']) {
      ctx.log(`ffmpeg.kenburns: ${cfg.outputPath} exists — skipping (set DAG_BUNDLE_FORCE_RERENDER=1 to force)`);
      return { ok: true, outputPath: cfg.outputPath, metadata: { skipped: true, reason: 'output_exists' } };
    }

    const filter = buildKenBurnsFilter({
      motion, zoom, totalFrames, fps, width, height,
      ...(cfg.fit ? { fit: cfg.fit } : {}),
      ...(cfg.padColor ? { padColor: cfg.padColor } : {}),
    });
    const args: string[] = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-framerate', String(fps), '-i', imagePath,
    ];
    if (audioPath) args.push('-i', audioPath);
    args.push('-filter_complex', `[0:v]${filter}[v]`, '-map', '[v]');
    if (audioPath) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k');
    args.push(
      // Cap the (infinitely-looped) image to exactly the clip length on the
      // OUTPUT side. -shortest also stops at the audio when present, so the
      // video and audio durations match (no over-generated zoompan frames).
      '-t', duration.toFixed(3),
      ...(audioPath ? ['-shortest'] : []),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-r', String(fps), '-movflags', '+faststart', outAbs,
    );

    ctx.log(`ffmpeg.kenburns: ${motion} on ${imagePath.split('/').pop()} → ${cfg.outputPath} (${duration.toFixed(1)}s @ ${fps}fps, ${width}x${height}${audioPath ? ', +audio' : ''})`);
    const r = await runFFmpeg(args);
    if (!r.ok) return { ok: false, error: `ffmpeg.kenburns: ffmpeg failed — ${r.stderr.split('\n').slice(-4).join(' ')}` };
    if (!existsSync(outAbs) || statSync(outAbs).size === 0) {
      return { ok: false, error: `ffmpeg.kenburns: ffmpeg reported success but ${outAbs} is missing/empty` };
    }
    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: { motion, durationSeconds: duration, fps, width, height, audio: !!audioPath },
    };
  }

  return { describe, run };
}

export const ffmpegKenBurnsRunner = createFfmpegKenBurnsRunner();
