// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareDheeCloudVideoRequest, runner } from '../../runners/dhee-cloud-video/dist/index.js';

let projectDir: string;
let originalEnv: NodeJS.ProcessEnv;

function makeCtx(config: Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  return {
    projectDir,
    node: {
      id: 'seedance_video',
      runner: {
        tool: 'dhee.cloud.video',
        config,
      },
    },
    inputs,
    log: vi.fn(),
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dhee-cloud-video-'));
  originalEnv = { ...process.env };
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('dhee.cloud.video runner', () => {
  it('returns a clear error when Dhee Cloud token is missing', async () => {
    process.env.DHEE_CLOUD_URL = 'https://cloud.dhee.test';
    delete process.env.DHEE_CLOUD_TOKEN;

    const result = await runner.run(makeCtx({
      prompt: 'Slow camera push',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/video.mp4',
    }));

    expect(result).toEqual({
      ok: false,
      error: 'dhee.cloud.video: missing DHEE_CLOUD_TOKEN',
    });
  });

  it('sends a Seedance request, writes the returned video, and preserves usage metadata', async () => {
    process.env.DHEE_CLOUD_URL = 'https://cloud.dhee.test';
    process.env.DHEE_CLOUD_TOKEN = 'desktop-token';
    writeFileSync(join(projectDir, 'first-frame.png'), Buffer.from('first-frame'));

    const videoBytes = Buffer.from('video-bytes');
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          kind: 'video',
          model: 'bytedance/seedance-2.0',
          jobId: 'video_job_1',
          generationId: 'gen_seedance',
          artifact: {
            dataUrl: `data:video/mp4;base64,${videoBytes.toString('base64')}`,
            mimeType: 'video/mp4',
            byteLength: videoBytes.byteLength,
          },
          metadata: {
            provider: 'openrouter',
            model: 'bytedance/seedance-2.0',
            jobId: 'video_job_1',
            generationId: 'gen_seedance',
            usage: { cost: 0.3363 },
            providerCostUsd: 0.3363,
            requestedDurationSeconds: 5,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'Slow camera push into the archive',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/seedance.mp4',
      firstFramePath: 'first-frame.png',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      generateAudio: false,
    }));

    expect(result).toMatchObject({
      ok: true,
      outputPath: 'out/seedance.mp4',
      metadata: {
        provider: 'dhee-cloud',
        upstreamProvider: 'openrouter',
        model: 'bytedance/seedance-2.0',
        jobId: 'video_job_1',
        generationId: 'gen_seedance',
        usage: { cost: 0.3363 },
        providerCostUsd: 0.3363,
        usedFirstFrame: true,
        requestedDurationSeconds: 5,
      },
    });
    expect(existsSync(join(projectDir, 'out/seedance.mp4'))).toBe(true);
    expect(readFileSync(join(projectDir, 'out/seedance.mp4'))).toEqual(videoBytes);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.dhee.test/api/cloud/media/video',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer desktop-token',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'bytedance/seedance-2.0',
      prompt: 'Slow camera push into the archive',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '720p',
      generateAudio: false,
      firstFrameUrl: `data:image/png;base64,${Buffer.from('first-frame').toString('base64')}`,
    });
  });

  it('resolves modelInput, promptInput, and firstFrameInput from project inputs', async () => {
    const prepared = await prepareDheeCloudVideoRequest(
      makeCtx(
        {
          promptInput: 'segment_motion_prompt',
          firstFrameInput: 'segment_image',
          modelInput: 'videoModel',
          outputPath: 'out/video.mp4',
        },
        {
          segment_motion_prompt: { motionPrompt: 'Slow parallax movement' },
          segment_image: 'data:image/png;base64,Zmlyc3Q=',
          videoModel: 'bytedance/seedance-2.0',
        },
      ),
    );

    expect(prepared.ok).toBe(true);
    expect(prepared.value.body).toMatchObject({
      model: 'bytedance/seedance-2.0',
      prompt: 'Slow parallax movement',
    });
  });

  it('fails clearly on an empty returned video artifact', async () => {
    process.env.DHEE_CLOUD_URL = 'https://cloud.dhee.test';
    process.env.DHEE_CLOUD_TOKEN = 'desktop-token';
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          artifact: {
            dataUrl: 'data:video/mp4;base64,',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'Slow camera push',
      model: 'bytedance/seedance-2.0',
      outputPath: 'out/video.mp4',
    }));

    expect(result).toEqual({
      ok: false,
      error: 'dhee.cloud.video: expected artifact to be a base64 data URL',
    });
  });
});
