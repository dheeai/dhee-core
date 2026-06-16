// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runner } from '../../runners/openrouter-video/dist/index.js';

let projectDir: string;
let originalEnv: NodeJS.ProcessEnv;

function makeCtx(config: Record<string, unknown>) {
  return {
    projectDir,
    node: {
      id: 'seedance_video',
      runner: {
        tool: 'openrouter.video',
        config,
      },
    },
    inputs: {},
    log: vi.fn(),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'openrouter-video-'));
  originalEnv = { ...process.env };
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('openrouter.video runner', () => {
  it('returns a clear error when OPENROUTER_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const result = await runner.run(makeCtx({
      prompt: 'Camera drifts across a product table',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/video.mp4',
    }));

    expect(result).toEqual({
      ok: false,
      error: 'openrouter.video: missing OPENROUTER_API_KEY',
    });
  });

  it('submits, polls, downloads, writes video, and returns usage cost metadata', async () => {
    process.env.OPENROUTER_API_KEY = 'or_key';
    const videoBytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'video_job_1',
        status: 'queued',
        polling_url: '/api/v1/videos/video_job_1',
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'video_job_1',
        status: 'completed',
        generation_id: 'gen_seedance',
        usage: { cost: 0.3363 },
        unsigned_urls: ['https://cdn.test/video_job_1.mp4'],
      }))
      .mockResolvedValueOnce(
        new Response(videoBytes, {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'Camera drifts across a product table',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/seedance.mp4',
      duration: 5,
      resolution: '720p',
      pollIntervalMs: 1,
      maxPolls: 3,
    }));

    expect(result).toMatchObject({
      ok: true,
      outputPath: 'out/seedance.mp4',
      metadata: {
        provider: 'openrouter',
        model: 'bytedance/seedance-2.0',
        jobId: 'video_job_1',
        generationId: 'gen_seedance',
        requestedDurationSeconds: 5,
      },
    });
    expect(result.metadata.usage).toEqual({ cost: 0.3363 });
    expect(existsSync(join(projectDir, 'out/seedance.mp4'))).toBe(true);
    expect(readFileSync(join(projectDir, 'out/seedance.mp4'))).toEqual(Buffer.from(videoBytes));

    const [, submitInit] = fetchMock.mock.calls[0];
    expect(submitInit.method).toBe('POST');
    expect(submitInit.headers.Authorization).toBe('Bearer or_key');
    expect(JSON.parse(submitInit.body)).toMatchObject({
      model: 'bytedance/seedance-2.0',
      prompt: 'Camera drifts across a product table',
      duration: 5,
      resolution: '720p',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/videos/video_job_1');
    expect(fetchMock.mock.calls[2][0]).toBe('https://cdn.test/video_job_1.mp4');
  });

  it('returns a clear error for failed OpenRouter video jobs', async () => {
    process.env.OPENROUTER_API_KEY = 'or_key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'video_job_1',
        status: 'queued',
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'video_job_1',
        status: 'failed',
        error: { message: 'provider failed' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'Camera drifts across a product table',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/seedance.mp4',
      pollIntervalMs: 1,
      maxPolls: 3,
    }));

    expect(result).toMatchObject({
      ok: false,
      error: 'openrouter.video: generation failed: provider failed',
    });
  });

  it('returns a clear error when the completed video download is empty', async () => {
    process.env.OPENROUTER_API_KEY = 'or_key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 'video_job_1',
        status: 'completed',
        unsigned_urls: ['https://cdn.test/empty.mp4'],
        usage: { cost: 0.06726 },
      }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([]), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'Camera drifts across a product table',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/seedance.mp4',
    }));

    expect(result).toEqual({
      ok: false,
      error: 'openrouter.video: downloaded video was empty',
    });
  });
});
