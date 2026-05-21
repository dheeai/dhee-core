/**
 * FFmpeg-based Video Assembly
 *
 * Resolves timeline segments to file paths and runs real FFmpeg concat
 * to produce the final assembled video. Handles style-aware validation
 * (anime/cinematic require video-only; documentary allows image→static-clip).
 */

import { existsSync, readFileSync, statSync, mkdirSync } from 'fs';
import { join, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import type { Timeline } from './types.js';
import { getFfmpegPath, getFfprobePath } from './ffmpegBinaries.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedSegment {
  segmentId: string;
  label: string;
  startTime: number;
  endTime: number;
  duration: number;
  filePath: string;
  mediaType: 'video' | 'image';
  /** Transition from the previous segment (default: 'cut') */
  transition?: string;
  /** Transition duration in seconds (default: 0.5) */
  transitionDuration?: number;
}

export interface ResolutionResult {
  resolved: ResolvedSegment[];
  errors: string[];
}

export interface AssemblyConfig {
  width?: number;
  height?: number;
  preset?: string;
  timeoutMs?: number;
  /** Watermark text drawn in the bottom-right corner. Defaults to env
   * `dhee_WATERMARK` or `'dhee-core'`. Pass an empty string to disable. */
  watermark?: string;
}

export interface AssemblyResult {
  success: boolean;
  outputPath: string;
  duration: number;
  fileSize: number;
}

interface ManifestAsset {
  id: string;
  type: string;
  path: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// File-path resolution
// ---------------------------------------------------------------------------

/**
 * Load the asset manifest from a project directory.
 */
function loadManifest(projectDir: string): ManifestAsset[] {
  const manifestPath = join(projectDir, 'assets', 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return data.assets ?? [];
  } catch {
    return [];
  }
}

/**
 * Detect whether a file is video or image by its extension.
 */
function detectMediaType(filePath: string): 'video' | 'image' | null {
  const ext = extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

function normalizeProjectRelativePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/**
 * Extract scene/shot numbers from a segment ID.
 * Handles patterns like "segment_1", "segment_5_shot_2", etc.
 */
function parseSegmentId(segmentId: string): { segmentNum?: number; shotNum?: number } {
  // segment_N_shot_M
  const shotMatch = segmentId.match(/segment_(\d+)_shot_(\d+)/);
  if (shotMatch) {
    return { segmentNum: parseInt(shotMatch[1]!, 10), shotNum: parseInt(shotMatch[2]!, 10) };
  }
  // segment_N
  const segMatch = segmentId.match(/segment_(\d+)/);
  if (segMatch) {
    return { segmentNum: parseInt(segMatch[1]!, 10) };
  }
  return {};
}

/**
 * Resolve each timeline segment to an absolute file path.
 *
 * 3-tier fallback:
 *   1. Direct layer.filePath → join with projectDir, verify exists
 *   2. layer.artifactId → look up in assets/manifest.json
 *   3. Neither present → search manifest for videos matching segment metadata
 */
export function resolveSegmentFilePaths(
  timeline: Timeline,
  projectDir: string
): ResolutionResult {
  const manifest = loadManifest(projectDir);
  const resolved: ResolvedSegment[] = [];
  const errors: string[] = [];

  for (const segment of timeline.segments) {
    if (segment.fillStatus !== 'filled') {
      errors.push(`Segment "${segment.id}" (${segment.label}) is not filled (status: ${segment.fillStatus})`);
      continue;
    }

    const visualLayer = segment.layers.find(
      l => l.type === 'visual' || l.type === 'narration_video'
    );

    let absolutePath: string | null = null;
    let mediaType: 'video' | 'image' | null = null;

    // Tier 1: artifactId -> manifest lookup is authoritative when available
    if (visualLayer?.artifactId) {
      const asset = manifest.find(a => a.id === visualLayer.artifactId);
      if (asset) {
        if (
          visualLayer.filePath &&
          normalizeProjectRelativePath(visualLayer.filePath) !== normalizeProjectRelativePath(asset.path)
        ) {
          errors.push(
            `Segment "${segment.id}" (${segment.label}): artifact ${visualLayer.artifactId} ` +
            `maps to ${asset.path} in the manifest, but timeline filePath was ${visualLayer.filePath}. ` +
            `Using manifest path.`
          );
        }
        const candidate = asset.path.startsWith('/')
          ? asset.path
          : join(projectDir, asset.path);
        if (existsSync(candidate)) {
          absolutePath = candidate;
          mediaType = detectMediaType(candidate);
        } else {
          errors.push(
            `Segment "${segment.id}" (${segment.label}): artifact ${visualLayer.artifactId} ` +
            `resolved to missing manifest path ${asset.path}`
          );
        }
      }
    }

    // Tier 2: Direct filePath on the layer only when no artifact-backed resolution exists
    if (!absolutePath && visualLayer?.filePath) {
      const candidate = visualLayer.filePath.startsWith('/')
        ? visualLayer.filePath
        : join(projectDir, visualLayer.filePath);
      if (existsSync(candidate)) {
        absolutePath = candidate;
        mediaType = detectMediaType(candidate);
      }
    }

    // Tier 3: Search manifest by segment metadata (scene/shot number) only without artifact-backed resolution
    if (!absolutePath) {
      const { segmentNum, shotNum } = parseSegmentId(segment.id);
      if (segmentNum !== undefined) {
        // Try to find a scene_video asset matching this segment
        const candidates = manifest.filter(a => {
          if (a.type !== 'scene_video') return false;
          const fileName = basename(a.path).toLowerCase();
          // Match patterns like "scene_5_shot_2", "scene5", "s5_shot2", etc.
          if (shotNum !== undefined) {
            return (
              fileName.includes(`scene_${segmentNum}_shot_${shotNum}`) ||
              fileName.includes(`scene${segmentNum}_shot${shotNum}`) ||
              fileName.includes(`s${segmentNum}_shot_${shotNum}`) ||
              fileName.includes(`s${segmentNum}_shot${shotNum}`)
            );
          }
          return (
            fileName.includes(`scene_${segmentNum}`) ||
            fileName.includes(`scene${segmentNum}`)
          );
        });

        if (candidates.length > 0) {
          // Prefer the most recently created asset
          candidates.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
          const best = candidates[0]!;
          const candidate = best.path.startsWith('/')
            ? best.path
            : join(projectDir, best.path);
          if (existsSync(candidate)) {
            absolutePath = candidate;
            mediaType = detectMediaType(candidate);
          }
        }

        // Tier 3.5: Scene-bundle fallback. When no shot-specific asset
        // matched, look for a scene_video registered as a bundle for
        // this scene (metadata.isBundle === true && sceneNumber match).
        // The bundle covers every shot in the scene — that's the
        // contract prompt-relay rendering establishes.
        if (!absolutePath) {
          const bundles = manifest.filter(a => {
            if (a.type !== 'scene_video') return false;
            const meta = (a.metadata ?? {});
            return meta['isBundle'] === true && meta['sceneNumber'] === segmentNum;
          });
          if (bundles.length > 0) {
            // Multi-chunk scenes: each chunk registers metadata.coversShots
            // listing which shot numbers it covers. Pick the chunk that
            // claims this shot. Single-bundle scenes (no coversShots
            // metadata) implicitly cover everything in the scene.
            const matchingChunk = bundles.find(a => {
              if (shotNum === undefined) return true;
              const meta = (a.metadata ?? {});
              const covers = meta['coversShots'];
              if (!Array.isArray(covers)) return true;
              return covers.includes(shotNum);
            });
            const chosen = matchingChunk
              ?? bundles.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]!;
            const candidate = chosen.path.startsWith('/')
              ? chosen.path
              : join(projectDir, chosen.path);
            if (existsSync(candidate)) {
              absolutePath = candidate;
              mediaType = detectMediaType(candidate);
            }
          }
        }
      }
    }

    if (!absolutePath) {
      errors.push(
        `Segment "${segment.id}" (${segment.label}): could not resolve to a file. ` +
        `Layer has filePath=${visualLayer?.filePath ?? 'none'}, artifactId=${visualLayer?.artifactId ?? 'none'}`
      );
      continue;
    }

    if (!mediaType) {
      errors.push(
        `Segment "${segment.id}" (${segment.label}): unknown media type for ${absolutePath}`
      );
      continue;
    }

    resolved.push({
      segmentId: segment.id,
      label: segment.label,
      startTime: segment.startTime,
      endTime: segment.endTime,
      duration: segment.duration,
      filePath: absolutePath,
      mediaType,
      transition: segment.transition?.type,
      transitionDuration: segment.transition ? segment.transition.durationMs / 1000 : undefined,
    });
  }

  return { resolved, errors };
}

/**
 * Collapse consecutive segments that resolve to the same physical file
 * into a single segment.
 *
 * Use case: prompt-relay scenes register one bundle mp4 covering N
 * shots, so all N timeline segments for that scene resolve to the same
 * filePath. Without this, the assembler would concat the bundle N
 * times — defeating the whole point of relay (smooth cross-shot
 * transitions baked into the bundle).
 *
 * Behavior:
 *  - run-length collapse on filePath (only adjacent dupes merge — a
 *    non-adjacent repeat is preserved as a deliberate playback)
 *  - the collapsed segment keeps the FIRST segment's id and transition
 *    so cross-scene transition logic on the next segment still works
 *  - duration = sum of run; startTime = first.startTime; endTime = last.endTime
 */
export function collapseBundleSegments(segments: ResolvedSegment[]): ResolvedSegment[] {
  const out: ResolvedSegment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.filePath === seg.filePath) {
      out[out.length - 1] = {
        ...last,
        endTime: seg.endTime,
        duration: last.duration + seg.duration,
      };
    } else {
      out.push(seg);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image → static video clip conversion (documentary style only)
// ---------------------------------------------------------------------------

/**
 * Convert a still image to a static video clip with silent audio.
 * Used for documentary-style projects where image segments are allowed.
 */
export async function convertImageToVideo(
  imagePath: string,
  duration: number,
  outputPath: string
): Promise<void> {
  // Ensure output directory exists
  const outputDir = join(outputPath, '..');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const args = [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264',
    '-t', String(duration),
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    '-c:a', 'aac',
    '-shortest',
    '-preset', 'fast',
    outputPath,
  ];

  await runFFmpeg(args, 60_000);
}

// ---------------------------------------------------------------------------
// FFmpeg concat assembly
// ---------------------------------------------------------------------------

/**
 * Build the per-segment video filter chunk: scale → pad → reset PTS.
 * Pure function — extracted for testability.
 */
export function buildVideoFilter(i: number, width: number, height: number): string {
  return (
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[v${i}]`
  );
}

/**
 * FFmpeg encode args needed for the output to play on mobile (WhatsApp,
 * iOS Safari, Android stock player) — pure, exported for testability.
 *
 * Diagnosed on 2026-04-27: a forwarded WhatsApp video showed a black
 * thumbnail and refused to play because:
 *  - overlay filter upgraded the pixel format to yuv444p
 *  - libx264 then picked profile 'High 4:4:4 Predictive'
 *  - moov atom landed at the end (no faststart)
 *  - audio was 24 kHz (some Android players prefer ≥44.1)
 *
 * These args lock the encode to mobile-safe values:
 *  - yuv420p / High@4.1 — universally decodable
 *  - faststart — moov at the head so previews/streaming work
 *  - 48 kHz stereo audio
 */
export function mobileCompatibleEncodeArgs(): string[] {
  return [
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level:v', '4.1',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
  ];
}

/**
 * Watermark image candidates, in priority order. We use a pre-rendered
 * PNG with `overlay` instead of `drawtext` because the standard
 * Homebrew/system FFmpeg builds don't ship `drawtext` (it requires
 * libfreetype, missing in many distributions). `overlay` is a core
 * filter present in every FFmpeg build.
 *
 * Regenerate with `scripts/render-watermark.ts` if the asset is missing.
 */
const WATERMARK_PNG_CANDIDATES = [
  'assets/watermark_dhee.png',
  'assets/watermark.png',
];

/**
 * Walk up from this source file's location until we hit a package.json —
 * that's the kshana-core repo root (or its installed package dir under
 * a host's node_modules). Returns null if no package.json is found in
 * 64 levels (defensive cap; real depth is ≤6).
 */
function findKshanaCoreRootFromSource(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 64; i += 1) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    /* CJS / no import.meta.url — fall through */
  }
  return null;
}

/**
 * Resolve the watermark PNG path (or `null` if none of the candidates
 * exist). Paths are checked in this order:
 *   1. relative to the current working directory
 *   2. relative to the dhee-core package root (walked up from this
 *      source file's location)
 *
 * The second tier matters in the desktop runtime: the host process's
 * cwd is `dhee-desktop/`, which doesn't ship `assets/watermark_*.png`.
 * Without this fallback the watermark silently disappears from every
 * assembled final video.
 */
export function resolveWatermarkPath(cwd: string = process.cwd()): string | null {
  for (const rel of WATERMARK_PNG_CANDIDATES) {
    const abs = join(cwd, rel);
    if (existsSync(abs)) return abs;
  }
  const repoRoot = findKshanaCoreRootFromSource();
  if (repoRoot) {
    for (const rel of WATERMARK_PNG_CANDIDATES) {
      const abs = join(repoRoot, rel);
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

/**
 * Build the `overlay` filter chunk that composites a pre-rendered
 * watermark PNG onto the bottom-right corner of the final output.
 *
 * Parameters:
 *  - inputLabel: the filter graph label feeding in (e.g. 'concated')
 *  - watermarkInputIdx: the FFmpeg input index of the PNG (e.g. the
 *    Nth `-i` argument, 0-based)
 *  - outputLabel: where the watermarked stream is published (e.g. 'outv')
 *  - outputHeight: the final video's height in pixels (e.g. 720). The
 *    watermark scales to ~6.94% of this — 50px tall at 720p, 75px at
 *    1080p, 150px at 4K. Width auto-derived from the source PNG's
 *    aspect ratio (square logo → 50×50 at 720p, matching the design
 *    spec).
 *
 * The PNG must already carry its own alpha channel (transparent
 * background). Pre-processing happens once when the asset is
 * generated/imported — the filter doesn't attempt to chroma-key at
 * render time.
 *
 * Pure — extracted for tests.
 */
export function buildWatermarkOverlayFilter(
  inputLabel: string,
  watermarkInputIdx: number,
  outputLabel: string,
  outputHeight: number = 720,
): string {
  // 50px / 720p ≈ 6.944%. Round to nearest pixel so the filter
  // expression stays integer and predictable across runs.
  const watermarkHeightPx = Math.max(16, Math.round(outputHeight * 0.0694));
  return (
    `[${watermarkInputIdx}:v]format=rgba,` +
      `scale=-1:${watermarkHeightPx}:flags=lanczos[wm];` +
    `[${inputLabel}][wm]overlay=x=W-w-24:y=H-h-24:format=auto[${outputLabel}]`
  );
}

/**
 * Compute the xfade transition duration for a given transition kind.
 *
 * Pure function — extracted for testability. The "cut" case used to be
 * 0.01 s, but FFmpeg's xfade silently produces broken/truncated output
 * when `duration` is shorter than 1 frame at the input framerate. At
 * 24 fps that's ~0.042 s, so 0.01 s breaks the whole chain. We use
 * 0.083 s (~2 frames at 24 fps) which is visually indistinguishable
 * from a hard cut and safe for any reasonable framerate ≥ 24.
 */
export function xfadeTransitionDuration(
  transition: string,
  configuredDuration: number | undefined,
): number {
  if (transition === 'cut') return 0.083;
  if (transition === 'flash_to_white') {
    return Math.min(configuredDuration ?? 0.2, 0.3);
  }
  return configuredDuration ?? 0.5;
}

/**
 * Compute the xfade offset and updated accumulator for one transition step.
 *
 * Pure function — extracted for testability. The cumulative accumulator must
 * use ACTUAL clip durations (videoDurations[i]) rather than the timeline's
 * planned segment.duration. Mismatch was the AV-sync bug on
 * woman_medieval_village_betrothed/final_video.mp4 — the planner declared
 * shorter shots than LTX 2.3 actually produced, so xfade truncated the
 * video to the planner's number while audio played in full.
 */
export function computeXfadeOffset(
  prevAccumulatedDuration: number,
  thisClipVideoDuration: number,
  transitionDuration: number,
): { offset: number; nextAccumulatedDuration: number } {
  const offset = Math.max(0, prevAccumulatedDuration - transitionDuration);
  const nextAccumulatedDuration =
    prevAccumulatedDuration + thisClipVideoDuration - transitionDuration;
  return { offset, nextAccumulatedDuration };
}

/**
 * Build the per-segment audio filter chunk.
 *
 * Pads (apad) then trims (atrim) the audio stream to exactly `videoDuration`
 * seconds. LTX 2.3 clips usually have audio ~10–30 ms shorter than video;
 * concatenating without this fix lets drift compound across N clips so the
 * final assembly's voice ends up hundreds of ms ahead of lip movements.
 *
 * When the segment has no audio, slices a silence stream to the same length.
 *
 * Pure function — extracted for testability.
 */
export function buildAudioFilter(
  i: number,
  hasAudio: boolean,
  videoDuration: number,
  silenceInputIdx: number,
): string {
  if (hasAudio) {
    return `[${i}:a]asetpts=PTS-STARTPTS,apad,atrim=duration=${videoDuration}[a${i}]`;
  }
  return `[${silenceInputIdx}:a]atrim=duration=${videoDuration},asetpts=PTS-STARTPTS[a${i}]`;
}

/**
 * Assemble resolved segments into a single video using FFmpeg concat filter.
 */
export async function assembleVideos(
  segments: ResolvedSegment[],
  outputPath: string,
  config: AssemblyConfig = {}
): Promise<AssemblyResult> {
  const {
    width = 1280,
    height = 720,
    preset = 'fast',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = config;

  // Run-length collapse consecutive segments that resolve to the same
  // file. This is what makes prompt-relay scenes work end-to-end:
  // 9 segments all pointing at the same scene-bundle mp4 collapse to
  // 1, so we concat the bundle once instead of 9× re-encoding it.
  segments = collapseBundleSegments(segments);

  if (segments.length === 0) {
    throw new Error('No segments to assemble');
  }

  // Ensure output directory exists
  const outputDir = join(outputPath, '..');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Probe each input for audio streams
  const hasAudio: boolean[] = segments.map(seg => {
    try {
      const probe = execFileSync(
        getFfprobePath(),
        ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', seg.filePath],
        { encoding: 'utf-8', timeout: 5000 }
      );
      return probe.trim().includes('audio');
    } catch {
      return false;
    }
  });

  // Probe each input for VIDEO duration. LTX 2.3 outputs typically have
  // audio ~10–30 ms shorter than video per clip; without padding, that drift
  // accumulates across N concatenated clips and the final assembly's voice
  // leads its lip movements by hundreds of ms by the end. We pad audio to
  // exactly the video duration before concat to keep each clip's [v][a]
  // pair length-matched.
  const videoDurations: number[] = segments.map(seg => {
    try {
      const probe = execFileSync(
        getFfprobePath(),
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'default=nw=1:nk=1', seg.filePath],
        { encoding: 'utf-8', timeout: 5000 }
      );
      const dur = parseFloat(probe.trim());
      return Number.isFinite(dur) && dur > 0 ? dur : seg.duration;
    } catch {
      return seg.duration;
    }
  });

  // Build FFmpeg command args
  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  let silenceInputIdx = -1;

  // Add a silence source if any input lacks audio
  if (hasAudio.some(h => !h)) {
    silenceInputIdx = segments.length;
    inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    inputArgs.push('-i', seg.filePath);
  }

  // Remap input indices: silence source is at silenceInputIdx, video files are at 0..N-1
  // But we pushed silence BEFORE the video files, so we need to adjust.
  // Actually, let's reorder: push video files first, then silence.
  // Rebuild inputArgs in the right order.
  inputArgs.length = 0;
  for (let i = 0; i < segments.length; i++) {
    inputArgs.push('-i', segments[i]!.filePath);
  }
  if (silenceInputIdx >= 0) {
    inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  for (let i = 0; i < segments.length; i++) {
    filterParts.push(
      buildVideoFilter(i, width, height),
      buildAudioFilter(i, hasAudio[i]!, videoDurations[i]!, silenceInputIdx),
    );
  }

  // Check if any segment has a non-cut transition
  const hasTransitions = segments.some((s, i) => i > 0 && s.transition && s.transition !== 'cut');

  if (hasTransitions) {
    // Build xfade chain for video, acrossfade chain for audio.
    // xfade works pairwise: [v0][v1]xfade=...[vx0]; [vx0][v2]xfade=...[vx1]; ...
    //
    // CRITICAL: offset = time in the ACCUMULATED output where transition begins.
    // After each xfade, accumulated duration = prev_accumulated + next_duration - transition_overlap.
    let prevVideoLabel = 'v0';
    let prevAudioLabel = 'a0';
    // Use ACTUAL clip duration, not segment.duration. Timeline durations
    // are PLANNED values — the actual LTX 2.3 outputs round to integer
    // frame counts at 24 fps, so a planned 2.14 s shot lands as a 3.04 s
    // clip. Using the planned 2.14 s as the xfade offset truncates the
    // video to its first 2 s of frames (only ~half the content), while
    // the audio chain plays in full — this is the AV-sync drift on the
    // first run of woman_medieval_village_betrothed (final_video.mp4 was
    // 44.7 s of video against 82.9 s of audio).
    let accumulatedDuration = videoDurations[0]!;

    // Map our transition names to FFmpeg xfade transition names
    const xfadeMap: Record<string, string> = {
      crossfade: 'fade',
      fade: 'fadeblack',
      dissolve: 'fade',
      dip_to_black: 'fadeblack',
      flash_to_white: 'fadewhite',
      wipe_left: 'wipeleft',
      wipe_right: 'wiperight',
      wipe_up: 'wipeup',
      wipe_down: 'wipedown',
      circle_open: 'circleopen',
      circle_close: 'circleclose',
      radial: 'radial',
      slide_left: 'slideleft',
      slide_right: 'slideright',
    };

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i]!;
      const transition = seg.transition ?? 'cut';
      const tDur = xfadeTransitionDuration(transition, seg.transitionDuration);

      // Offset = end of accumulated output minus transition overlap.
      // Uses videoDurations (actual) — see computeXfadeOffset doc.
      const { offset, nextAccumulatedDuration } = computeXfadeOffset(
        accumulatedDuration,
        videoDurations[i]!,
        tDur,
      );

      // The final video label is 'concated' — the watermark step (below)
      // takes 'concated' → 'outv' so 'outv' always carries the watermarked
      // stream. Skip the rename when there's no watermark.
      const finalVideoLabel = config.watermark === '' ? 'outv' : 'concated';
      const outVideoLabel = i < segments.length - 1 ? `vx${i}` : finalVideoLabel;
      const outAudioLabel = i < segments.length - 1 ? `ax${i}` : 'outa';

      const ffmpegTransition = transition === 'cut' ? 'fade' : (xfadeMap[transition] ?? 'fade');
      filterParts.push(
        `[${prevVideoLabel}][v${i}]xfade=transition=${ffmpegTransition}:duration=${tDur}:offset=${offset}[${outVideoLabel}]`
      );

      // Audio crossfade
      filterParts.push(
        `[${prevAudioLabel}][a${i}]acrossfade=d=${tDur}:c1=tri:c2=tri[${outAudioLabel}]`
      );

      accumulatedDuration = nextAccumulatedDuration;

      prevVideoLabel = outVideoLabel;
      prevAudioLabel = outAudioLabel;
    }
  } else {
    // No transitions — simple concat (original behavior)
    const concatInputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
    const finalVideoLabel = config.watermark === '' ? 'outv' : 'concated';
    filterParts.push(
      `${concatInputs}concat=n=${segments.length}:v=1:a=1[${finalVideoLabel}][outa]`
    );
  }

  // Watermark: composite a pre-rendered PNG (Apple Chancery 'dhee') onto
  // the bottom-right. We use overlay (always available) instead of drawtext
  // (often missing on Homebrew/system FFmpeg builds because libfreetype is
  // not enabled by default). Set dhee_WATERMARK=off to disable, or supply
  // `watermark: ''` in config.
  const watermarkDisabled =
    config.watermark === '' || process.env['dhee_WATERMARK'] === 'off';
  const watermarkPath = watermarkDisabled ? null : resolveWatermarkPath();
  if (watermarkPath) {
    // Append PNG as an extra -i input; track its index for the filter.
    const watermarkInputIdx = inputArgs.filter(a => a === '-i').length;
    inputArgs.push('-i', watermarkPath);
    filterParts.push(buildWatermarkOverlayFilter('concated', watermarkInputIdx, 'outv', height));
  } else if (config.watermark !== '' && process.env['dhee_WATERMARK'] !== 'off') {
    // No watermark asset found — log a hint but don't fail the assembly.
    // We still need to alias `concated` to `outv` if no watermark was applied.
    filterParts.push(`[concated]copy[outv]`);
  }

  const filterComplex = filterParts.join('; ');

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', preset,
    '-c:a', 'aac',
    ...mobileCompatibleEncodeArgs(),
    outputPath,
  ];

  await runFFmpeg(args, timeoutMs);

  // Get output file stats
  const stats = statSync(outputPath);
  const totalDuration = videoDurations.reduce((sum, d) => sum + d, 0);

  return {
    success: true,
    outputPath,
    duration: totalDuration,
    fileSize: stats.size,
  };
}

// ---------------------------------------------------------------------------
// FFmpeg runner
// ---------------------------------------------------------------------------

/**
 * Spawn FFmpeg as a child process, capture stderr, return on completion.
 * Rejects on non-zero exit code or timeout.
 */
export function runFFmpeg(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let stdout = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stderr); // FFmpeg puts progress info on stderr
      } else {
        reject(new Error(`FFmpeg exited with code ${code}:\n${stderr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });
  });
}
