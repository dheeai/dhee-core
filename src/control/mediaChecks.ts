import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  realpathSync,
  statSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { ffmpegBin, ffprobeBin } from '../dag/runners/ffmpegBin.js';
import { listGpuTargets } from './gpuPreparation.js';
import { openEventLog } from '../dag/eventLog/EventLog.js';
import { projectWalkState } from '../dag/eventLog/projectWalkState.js';
import { acquireWalkLock, isWalkLockResult } from '../dag/projectWalkLock.js';

export const mediaCheckSchema = z
  .object({
    projectDir: z.string().refine(isAbsolute),
    branchId: z.string().min(1).default('main'),
    nodeId: z.string().regex(/^[\w.-]+$/),
    itemId: z
      .string()
      .regex(/^[\w.-]+$/)
      .optional(),
    expectedAudio: z.boolean().default(false),
    expectedDurationSec: z.number().positive().max(86400).optional(),
  })
  .strict();
type Check = { code: string; status: 'pass' | 'fail' | 'warning' | 'unavailable'; message: string };
const MAX_BYTES = 2 * 1024 ** 3;
const FORMATS = 'mov,matroska,webm,wav,mp3,ogg,flac,aac';
function command(
  binary: string,
  args: string[],
  signal?: AbortSignal
): Promise<{ ok: boolean; stdout: string; stderr: string; unavailable: boolean }> {
  return new Promise(resolveResult => {
    execFile(
      binary,
      args,
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60000, killSignal: 'SIGKILL', signal },
      (error, stdout, stderr) =>
        resolveResult({
          ok: !error,
          stdout,
          stderr: String(stderr || error?.message || ''),
          unavailable: !!error && (typeof error.code === 'string' || error.killed === true),
        })
    );
  });
}
async function digest(path: string, signal: AbortSignal | undefined, copyTo?: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        done(new Error('Media exceeds the 2 GiB check limit.'));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  if (copyTo)
    await pipeline(
      createReadStream(path),
      meter,
      createWriteStream(copyTo, { flags: 'wx', mode: 0o600 }),
      { signal }
    );
  else {
    for await (const value of createReadStream(path, { signal })) {
      const chunk = value as Buffer;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error('Media exceeds the 2 GiB check limit.');
      hash.update(chunk);
    }
  }
  return { sha256: hash.digest('hex'), bytes };
}
function confined(projectDir: string, path: string) {
  const abs = realpathSync(resolve(projectDir, path));
  const rel = relative(projectDir, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Media must remain inside the project.');
  if (!statSync(abs).isFile()) throw new Error('Selected media is not a regular file.');
  return abs;
}
export async function checkProjectMedia(
  input: z.input<typeof mediaCheckSchema>,
  signal?: AbortSignal
) {
  const req = mediaCheckSchema.parse(input);
  signal?.throwIfAborted();
  const projectDir = realpathSync(req.projectDir);
  const lock = acquireWalkLock(projectDir);
  if (isWalkLockResult(lock))
    throw new Error('A project operation is in progress. Check media after it finishes.');
  let scratch: string | undefined;
  try {
    const target = listGpuTargets({ projectDir, branchId: req.branchId }).targets.find(
      t => t.nodeId === req.nodeId && t.itemId === req.itemId
    );
    if (!target || !['video', 'audio'].includes(target.format))
      throw new Error('Choose a video or audio target from the current plan.');
    const key = req.itemId === undefined ? req.nodeId : `${req.nodeId}:${req.itemId}`;
    const selected = () =>
      projectWalkState([...openEventLog(projectDir).read()], { branchId: req.branchId }).nodes[key];
    const state = selected();
    if (state?.status !== 'completed' || !state.outputPath || !state.selectedVersionId)
      throw new Error('Selected media is unavailable or incomplete.');
    const abs = confined(projectDir, state.outputPath);
    if (statSync(abs).size > MAX_BYTES) throw new Error('Media exceeds the 2 GiB check limit.');
    scratch = mkdtempSync(join(tmpdir(), 'dhee-media-check-'));
    const snapshot = join(scratch, `source${extname(abs)}`);
    const sourceHash = await digest(abs, signal, snapshot);
    const checks: Check[] = [];
    const media: {
      durationSec?: number;
      video?: { width: number; height: number; fps: number | null };
      audio?: {
        channels: number;
        sampleRate: number;
        peakDb?: number | null;
        meanDb?: number | null;
      };
      silenceIntervals?: { start: number; end?: number }[];
    } = {};
    const probe = await command(
      ffprobeBin(),
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        FORMATS,
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        snapshot,
      ],
      signal
    );
    if (!probe.ok)
      checks.push({
        code: 'probe',
        status: probe.unavailable ? 'unavailable' : 'fail',
        message: `Media metadata could not be read: ${probe.stderr.slice(-600)}`,
      });
    else {
      let data: { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
      try {
        data = JSON.parse(probe.stdout) as typeof data;
      } catch {
        throw new Error('Media probe returned invalid JSON.');
      }
      const video = data.streams?.find(s => s.codec_type === 'video');
      const audio = data.streams?.find(s => s.codec_type === 'audio');
      const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
      if (Number.isFinite(duration) && duration > 0) {
        media.durationSec = duration;
        checks.push({
          code: 'duration',
          status:
            req.expectedDurationSec !== undefined &&
            Math.abs(duration - req.expectedDurationSec) >
              Math.max(0.25, req.expectedDurationSec * 0.03)
              ? 'fail'
              : 'pass',
          message:
            req.expectedDurationSec === undefined
              ? `Duration: ${duration.toFixed(3)} seconds.`
              : `Duration ${duration.toFixed(3)}s; expected ${req.expectedDurationSec}s (tolerance ${Math.max(0.25, req.expectedDurationSec * 0.03).toFixed(3)}s).`,
        });
      } else
        checks.push({
          code: 'duration',
          status: 'fail',
          message: 'No positive finite duration was reported.',
        });
      if (target.format === 'video' && !video)
        checks.push({
          code: 'video-required',
          status: 'fail',
          message: 'The selected video has no video stream.',
        });
      if ((req.expectedAudio || target.format === 'audio') && !audio)
        checks.push({
          code: 'audio-required',
          status: 'fail',
          message: 'Expected audio is missing.',
        });
      if (video) {
        const [n, d] = (typeof video.avg_frame_rate === 'string' ? video.avg_frame_rate : '0/0')
          .split('/')
          .map(Number);
        const fps = n! / d!;
        media.video = {
          width: Number(video.width),
          height: Number(video.height),
          fps: Number.isFinite(fps) ? fps : null,
        };
        checks.push({
          code: 'video-format',
          status: media.video.width > 0 && media.video.height > 0 && fps > 0 ? 'pass' : 'fail',
          message: `Video ${media.video.width} × ${media.video.height}, ${media.video.fps ?? 'unknown'} fps.`,
        });
      }
      if (audio) {
        media.audio = { channels: Number(audio.channels), sampleRate: Number(audio.sample_rate) };
        checks.push({
          code: 'audio-format',
          status: media.audio.channels > 0 && media.audio.sampleRate > 0 ? 'pass' : 'fail',
          message: `Audio ${media.audio.channels} channels, ${media.audio.sampleRate} Hz.`,
        });
      }
      const decoded = await command(
        ffmpegBin(),
        [
          '-nostdin',
          '-v',
          'error',
          '-xerror',
          '-protocol_whitelist',
          'file,pipe',
          '-format_whitelist',
          FORMATS,
          '-i',
          snapshot,
          '-map',
          '0:v?',
          '-map',
          '0:a?',
          '-f',
          'null',
          '-',
        ],
        signal
      );
      checks.push({
        code: 'decode',
        status: decoded.ok ? 'pass' : decoded.unavailable ? 'unavailable' : 'fail',
        message: decoded.ok
          ? 'Complete audio/video decode succeeded.'
          : `Decode did not complete: ${decoded.stderr.slice(-600)}`,
      });
      if (audio) {
        const measured = await command(
          ffmpegBin(),
          [
            '-nostdin',
            '-v',
            'info',
            '-protocol_whitelist',
            'file,pipe',
            '-format_whitelist',
            FORMATS,
            '-i',
            snapshot,
            '-map',
            '0:a:0',
            '-vn',
            '-af',
            'volumedetect,silencedetect=noise=-50dB:d=0.5',
            '-f',
            'null',
            '-',
          ],
          signal
        );
        const peak = measured.stderr.match(/max_volume:\s*(-?inf|[-\d.]+) dB/);
        const mean = measured.stderr.match(/mean_volume:\s*(-?inf|[-\d.]+) dB/);
        if (!measured.ok || !peak || !mean)
          checks.push({
            code: 'audio-measurement',
            status: 'unavailable',
            message: 'Audio measurements were not completed; listen manually.',
          });
        else {
          const peakDb = Number(peak[1]);
          const meanDb = Number(mean[1]);
          media.audio!.peakDb = Number.isFinite(peakDb) ? peakDb : null;
          media.audio!.meanDb = Number.isFinite(meanDb) ? meanDb : null;
          checks.push({
            code: 'audio-peak',
            status: peakDb >= -0.1 ? 'warning' : 'pass',
            message:
              peakDb >= -0.1
                ? 'Peak is near 0 dBFS; inspect for clipping. This is not proof of clipping.'
                : `Peak level: ${peak[1]} dBFS. No delivery loudness target is applied.`,
          });
          const intervals: { start: number; end?: number }[] = [];
          for (const match of measured.stderr.matchAll(/silence_(start|end):\s*([\d.]+)/g)) {
            if (match[1] === 'start') intervals.push({ start: Number(match[2]) });
            else if (intervals.length) intervals[intervals.length - 1]!.end = Number(match[2]);
          }
          media.silenceIntervals = intervals;
          checks.push({
            code: 'silence',
            status: intervals.length ? 'warning' : 'pass',
            message: intervals.length
              ? `${intervals.length} silence interval(s) below -50 dB for at least 0.5s. Review intentional pauses; this does not establish missing speech.`
              : 'No silence intervals met the -50 dB / 0.5s threshold.',
          });
        }
      }
    }
    signal?.throwIfAborted();
    const currentAbs = confined(projectDir, state.outputPath);
    const currentHash = await digest(currentAbs, signal);
    signal?.throwIfAborted();
    const current = selected();
    if (
      current?.status !== 'completed' ||
      current.selectedVersionId !== state.selectedVersionId ||
      current.outputPath !== state.outputPath ||
      currentAbs !== abs ||
      confined(projectDir, state.outputPath) !== abs ||
      currentHash.sha256 !== sourceHash.sha256
    )
      throw new Error('Selected media changed during checks. Run checks again.');
    return {
      checkedAt: new Date().toISOString(),
      source: {
        projectDir,
        branchId: req.branchId,
        nodeId: req.nodeId,
        itemId: req.itemId,
        versionId: state.selectedVersionId,
        outputPath: state.outputPath,
        ...sourceHash,
      },
      expectations: {
        audioRequired: req.expectedAudio || target.format === 'audio',
        durationSec: req.expectedDurationSec,
      },
      technicalStatus: checks.some(c => c.status === 'fail')
        ? 'issues'
        : checks.some(c => c.status === 'unavailable')
          ? 'unavailable'
          : checks.some(c => c.status === 'warning')
            ? 'review'
            : 'passed',
      checks,
      media,
      creativeApproval: 'required' as const,
      manualChecks: [
        'Watch scene continuity, character/prop consistency and intended action.',
        'Listen for correct words, speaker identity, pronunciation and natural phrasing.',
        'Review picture and sound together for lip sync, cut timing and unintended speech.',
      ],
      limits: {
        maxBytes: MAX_BYTES,
        commandTimeoutSec: 60,
        scope: 'Selected media only; no assembly, export or creative approval.',
      },
    };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    lock.release();
  }
}
