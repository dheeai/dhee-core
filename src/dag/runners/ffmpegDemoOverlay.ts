/**
 * `ffmpeg.demo_overlay` — a talking-head "demo" clip where a pixel-exact
 * screenshot overlay choreographs: (delay) → INSET top-right → EXPAND to
 * fullscreen → HOLD → COLLAPSE back to inset → inset to the end. Deterministic
 * (overlay/kenburns/xfade — no generative model touches the screenshot).
 *
 * Lip-sync is preserved: the video phases are assembled with xfades whose
 * lengths sum to the base clip's duration, and the base's CONTINUOUS audio is
 * muxed over the result. During fullscreen the creator is hidden (not muted),
 * so when the inset resumes the video timestamp == audio timestamp.
 *
 * Config:
 *   - baseInput (string): input id → the creator talking clip (video+audio).
 *   - overlayInput (string): input id → the screenshot image path.
 *   - appearAt (s): when the overlay first pops in (default 6). Before this it's
 *       just the talking head.
 *   - insetHold (s): inset shown before expanding (default 5).
 *   - expandDur (s): expand transition (default 1).
 *   - fullscreenHold (s): screenshot full-frame (default 10).
 *   - collapseDur (s): collapse transition (default 1).
 *   - insetScale, insetMargin, insetBorderWidth, insetBorderColor: inset look.
 *   - expandTransition / collapseTransition: xfade transition names.
 *   - padColor: letterbox colour for the fullscreen screenshot.
 *   - outputPath: set by the walker.
 */
import { existsSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ffmpegBin, ffprobeBin } from './ffmpegBin.js';
import { buildKenBurnsFilter } from './ffmpegKenBurns.js';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';

interface DemoOverlayConfig {
  baseInput?: string;
  overlayInput?: string;
  appearAt?: number;
  insetHold?: number;
  expandDur?: number;
  fullscreenHold?: number;
  collapseDur?: number;
  insetScale?: number;
  insetMargin?: number;
  insetBorderWidth?: number;
  insetBorderColor?: string;
  expandTransition?: string;
  collapseTransition?: string;
  padColor?: string;
  fps?: number;
  outputPath?: string;
  forceRerun?: boolean;
}

export interface DemoSegments {
  appearAt: number;
  tExpand: number;      // base time the expand starts
  clip1Dur: number;     // base[0..clip1Dur] + inset → segment A
  fullDur: number;      // fullscreen kenburns length
  clip3Start: number;   // base time the inset resumes
  clip3Dur: number;     // base[clip3Start..D] + inset → segment C
  expandOffset: number; // xfade offset within clip1
  collapseOffset: number; // xfade offset within (clip1⊕full)
}

/**
 * Pure timing math. Phases on the FINAL timeline:
 *   0..appearAt      talking head, no overlay
 *   ..+insetHold     inset
 *   ..+expandDur     expand
 *   ..+fullscreenHold fullscreen
 *   ..+collapseDur   collapse
 *   ..D              inset
 * Segment lengths are chosen so the xfaded total == D (audio stays aligned).
 * Clamps the choreography to fit D; if D is too short everything still lands
 * inside [0,D].
 */
export function computeDemoSegments(D: number, cfg: DemoOverlayConfig): DemoSegments {
  const expandDur = Math.max(0.2, cfg.expandDur ?? 1);
  const collapseDur = Math.max(0.2, cfg.collapseDur ?? 1);
  let appearAt = Math.max(0, cfg.appearAt ?? 6);
  let insetHold = Math.max(0, cfg.insetHold ?? 5);
  let fullscreenHold = Math.max(0.5, cfg.fullscreenHold ?? 10);
  // Ensure the whole choreography + at least 1s trailing inset fits in D.
  const fixed = expandDur + collapseDur;
  let need = appearAt + insetHold + fixed + fullscreenHold + 1;
  if (need > D) {
    // shrink the flexible holds proportionally to fit
    const flexible = appearAt + insetHold + fullscreenHold;
    const avail = Math.max(0.1, D - fixed - 1);
    const k = flexible > 0 ? avail / flexible : 0;
    appearAt *= k; insetHold *= k; fullscreenHold *= k;
  }
  const tExpand = appearAt + insetHold;
  const clip1Dur = tExpand + expandDur;
  const fullDur = expandDur + fullscreenHold + collapseDur;
  const clip3Start = tExpand + expandDur + fullscreenHold;
  const clip3Dur = Math.max(collapseDur + 0.3, D - clip3Start);
  return {
    appearAt,
    tExpand,
    clip1Dur,
    fullDur,
    clip3Start,
    clip3Dur,
    expandOffset: tExpand,
    collapseOffset: tExpand + expandDur + fullscreenHold,
  };
}

function probe(path: string, entries: string): string {
  return execFileSync(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', entries, '-of', 'default=nw=1:nk=1', path], { encoding: 'utf-8' }).trim();
}
function probeDuration(path: string): number {
  return parseFloat(execFileSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', path], { encoding: 'utf-8' }).trim()) || 0;
}
function runFFmpeg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (c) => res({ ok: c === 0, stderr }));
    p.on('error', (e) => res({ ok: false, stderr: `spawn failed: ${e.message}` }));
  });
}

function firstByExt(ctx: RunnerContext, re: RegExp, prefer?: string): string | undefined {
  if (prefer) { const v = ctx.inputs[prefer]; if (typeof v === 'string' && re.test(v) && existsSync(v)) return v; }
  for (const inp of ctx.node.inputs) { const v = ctx.inputs[inp.from]; if (typeof v === 'string' && re.test(v) && existsSync(v)) return v; }
  for (const v of Object.values(ctx.inputs)) { if (typeof v === 'string' && re.test(v) && existsSync(v)) return v; }
  return undefined;
}

export function createFfmpegDemoOverlayRunner(): Runner {
  const describe = (): RunnerDescription => ({
    id: 'ffmpeg.demo_overlay',
    displayName: 'FFmpeg Demo Overlay',
    description: 'Talking-head clip with a pixel-exact screenshot that pops in as a top-right inset, expands to fullscreen, holds, then collapses back — deterministic (no model touches the screenshot), lip-sync preserved.',
    capabilities: ['video-composite', 'overlay', 'screencast', 'pip'],
    modalities: { input: ['video', 'image'], output: ['video'] },
    configSchema: { type: 'object', required: ['outputPath'], properties: {
      baseInput: { type: 'string' }, overlayInput: { type: 'string' },
      appearAt: { type: 'number' }, insetHold: { type: 'number' }, expandDur: { type: 'number' },
      fullscreenHold: { type: 'number' }, collapseDur: { type: 'number' },
      insetScale: { type: 'number' }, insetMargin: { type: 'number' },
      insetBorderWidth: { type: 'number' }, insetBorderColor: { type: 'string' },
      expandTransition: { type: 'string' }, collapseTransition: { type: 'string' }, padColor: { type: 'string' },
    } },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as unknown as DemoOverlayConfig;
    if (!cfg.outputPath) return { ok: false, error: 'ffmpeg.demo_overlay: missing outputPath' };
    const base = firstByExt(ctx, /\.(mp4|mov|webm|mkv|m4v)$/i, cfg.baseInput);
    if (!base) return { ok: false, error: `ffmpeg.demo_overlay: no base video (baseInput='${cfg.baseInput ?? ''}')` };
    const shot = firstByExt(ctx, /\.(png|jpe?g|webp|bmp)$/i, cfg.overlayInput);
    if (!shot) return { ok: false, error: `ffmpeg.demo_overlay: no overlay image (overlayInput='${cfg.overlayInput ?? ''}')` };

    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    mkdirSync(dirname(outAbs), { recursive: true });
    if (!cfg.forceRerun && existsSync(outAbs) && statSync(outAbs).size > 0 && !process.env['DAG_BUNDLE_FORCE_RERENDER']) {
      ctx.log(`ffmpeg.demo_overlay: ${cfg.outputPath} exists — skipping`);
      return { ok: true, outputPath: cfg.outputPath, metadata: { skipped: true } };
    }

    const W = parseInt(probe(base, 'stream=width'), 10) || 1280;
    const H = parseInt(probe(base, 'stream=height'), 10) || 720;
    const D = parseFloat(execFileSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', base], { encoding: 'utf-8' }).trim()) || 0;
    if (D <= 0) return { ok: false, error: `ffmpeg.demo_overlay: bad base duration for ${base}` };
    const fps = cfg.fps ?? 24;
    const seg = computeDemoSegments(D, cfg);
    const scale = cfg.insetScale ?? 0.36, margin = cfg.insetMargin ?? 40;
    const bw = cfg.insetBorderWidth ?? 6, bc = cfg.insetBorderColor ?? 'white';
    const padColor = cfg.padColor ?? '0x111319';
    // Defaults chosen to work on the bundled ffmpeg 4.4 (no 'zoomin' there).
    // rectcrop = a centered rectangle grows to reveal the next clip → reads as
    // the overlay box expanding to fill, then a box closing back to the inset.
    const expandDur = cfg.expandDur ?? 1;
    const collapseDur = cfg.collapseDur ?? 1;
    const expandT = cfg.expandTransition ?? 'rectcrop';
    const collapseT = cfg.collapseTransition ?? 'rectcrop';
    const ow = Math.round(W * scale);

    const tmp = join(tmpdir(), `demo-overlay-${process.pid}-${Math.round(seg.clip1Dur * 1000)}`);
    mkdirSync(tmp, { recursive: true });
    const c1 = join(tmp, 'c1.mp4'), full = join(tmp, 'full.mp4'), c3 = join(tmp, 'c3.mp4'), ab = join(tmp, 'ab.mp4'), vid = join(tmp, 'vid.mp4');
    const cleanup = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } };

    // inset overlay filter (border via pad), appearing at appearAt with a 0.3s fade-in.
    const insetOv = (appearAt: number) =>
      `[1:v]scale=${ow}:-2,pad=iw+${2 * bw}:ih+${2 * bw}:${bw}:${bw}:${bc},format=rgba,` +
      `fade=t=in:st=${appearAt.toFixed(2)}:d=0.3:alpha=1[ov];` +
      `[0:v][ov]overlay=W-overlay_w-${margin}:${margin}:enable='gte(t,${appearAt.toFixed(2)})':format=auto[v]`;
    const kb = buildKenBurnsFilter({ motion: 'in', zoom: 1.08, totalFrames: Math.round(seg.fullDur * fps), fps, width: W, height: H, fit: 'contain', padColor });

    try {
      // Clip 1: base[0..clip1Dur] + inset (overlay appears at appearAt)
      let r = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-t', seg.clip1Dur.toFixed(3), '-i', base,
        '-loop', '1', '-i', shot, '-filter_complex', insetOv(seg.appearAt), '-map', '[v]',
        '-t', seg.clip1Dur.toFixed(3), '-r', String(fps), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', c1]);
      if (!r.ok) { cleanup(); return { ok: false, error: `demo_overlay clip1: ${r.stderr.slice(-300)}` }; }
      // Fullscreen kenburns of the screenshot
      r = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', String(fps), '-i', shot,
        '-filter_complex', `[0:v]${kb}[v]`, '-map', '[v]', '-t', seg.fullDur.toFixed(3), '-r', String(fps), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', full]);
      if (!r.ok) { cleanup(); return { ok: false, error: `demo_overlay full: ${r.stderr.slice(-300)}` }; }
      // Clip 3: base[clip3Start..D] + inset (always on)
      r = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-ss', seg.clip3Start.toFixed(3), '-t', seg.clip3Dur.toFixed(3), '-i', base,
        '-loop', '1', '-i', shot, '-filter_complex', insetOv(0), '-map', '[v]',
        '-t', seg.clip3Dur.toFixed(3), '-r', String(fps), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', c3]);
      if (!r.ok) { cleanup(); return { ok: false, error: `demo_overlay clip3: ${r.stderr.slice(-300)}` }; }
      // xfade offsets must fit the *actual* encoded clip lengths — frame rounding on
      // Linux can shave ~1 frame off -t targets, and xfade rejects offset > dur − transition.
      const c1Dur = probeDuration(c1);
      const expandOffset = Math.min(seg.expandOffset, Math.max(0, c1Dur - expandDur - 0.001));
      // xfade expand: c1 → full
      r = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', c1, '-i', full, '-filter_complex',
        `[0:v][1:v]xfade=transition=${expandT}:duration=${expandDur.toFixed(2)}:offset=${expandOffset.toFixed(3)}[v]`,
        '-map', '[v]', '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', ab]);
      if (!r.ok) { cleanup(); return { ok: false, error: `demo_overlay expand: ${r.stderr.slice(-300)}` }; }
      const abDur = probeDuration(ab);
      const collapseOffset = Math.max(0, abDur - collapseDur - 0.001);
      // xfade collapse: ab → c3
      r = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', ab, '-i', c3, '-filter_complex',
        `[0:v][1:v]xfade=transition=${collapseT}:duration=${collapseDur.toFixed(2)}:offset=${collapseOffset.toFixed(3)}[v]`,
        '-map', '[v]', '-r', String(fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', vid]);
      if (!r.ok) { cleanup(); return { ok: false, error: `demo_overlay collapse: ${r.stderr.slice(-300)}` }; }
      // Mux the base's continuous audio over the assembled video
      r = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-i', vid, '-i', base,
        '-map', '0:v', '-map', '1:a?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outAbs]);
      if (!r.ok) { cleanup(); return { ok: false, error: `demo_overlay mux: ${r.stderr.slice(-300)}` }; }
    } finally {
      cleanup();
    }
    ctx.log(`ffmpeg.demo_overlay: ${cfg.outputPath} (appear ${seg.appearAt.toFixed(1)}s → inset → expand → fullscreen → collapse, ${W}x${H})`);
    if (!existsSync(outAbs) || statSync(outAbs).size === 0) return { ok: false, error: 'ffmpeg.demo_overlay: output missing/empty' };
    return { ok: true, outputPath: cfg.outputPath, metadata: { width: W, height: H, durationSeconds: D } };
  }

  return { describe, run };
}

export const ffmpegDemoOverlayRunner = createFfmpegDemoOverlayRunner();
