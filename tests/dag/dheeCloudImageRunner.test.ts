// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareDheeCloudImageRequest, runner } from '../../runners/dhee-cloud-image/dist/index.js';

let projectDir: string;
let originalEnv: NodeJS.ProcessEnv;

function makeCtx(config: Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  return {
    projectDir,
    node: {
      id: 'seedream_image',
      runner: {
        tool: 'dhee.cloud.image',
        config,
      },
    },
    inputs,
    log: vi.fn(),
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'dhee-cloud-image-'));
  originalEnv = { ...process.env };
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('dhee.cloud.image runner', () => {
  it('returns a clear error when Dhee Cloud auth is missing', async () => {
    delete process.env.DHEE_CLOUD_URL;
    delete process.env.DHEE_CLOUD_TOKEN;

    const result = await runner.run(makeCtx({
      prompt: 'A clean studio product shot',
      model: 'bytedance-seed/seedream-4.5',
      outputPath: 'out/image.png',
    }));

    expect(result).toEqual({
      ok: false,
      error: 'dhee.cloud.image: missing DHEE_CLOUD_URL',
    });
  });

  it('builds a Seedream request, writes the returned image, and preserves provider metadata', async () => {
    process.env.DHEE_CLOUD_URL = 'https://cloud.dhee.test';
    process.env.DHEE_CLOUD_TOKEN = 'desktop-token';
    mkdirSync(join(projectDir, 'refs'), { recursive: true });
    writeFileSync(join(projectDir, 'refs/source.png'), Buffer.from('reference-image'));

    const imageBytes = Buffer.from('generated-image');
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          kind: 'image',
          model: 'bytedance-seed/seedream-4.5',
          responseId: 'chatcmpl_seedream',
          artifact: {
            dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`,
            mimeType: 'image/png',
            byteLength: imageBytes.byteLength,
          },
          metadata: {
            provider: 'openrouter',
            model: 'bytedance-seed/seedream-4.5',
            responseId: 'chatcmpl_seedream',
            usage: { cost: 0.04 },
            providerCostUsd: 0.04,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'A cinematic scooter product image',
      model: 'bytedance-seed/seedream-4.5',
      outputPath: 'out/seedream.png',
      referenceImagePath: 'refs/source.png',
      imageConfig: { output_format: 'png' },
    }));

    expect(result).toMatchObject({
      ok: true,
      outputPath: 'out/seedream.png',
      metadata: {
        provider: 'dhee-cloud',
        upstreamProvider: 'openrouter',
        model: 'bytedance-seed/seedream-4.5',
        responseId: 'chatcmpl_seedream',
        usage: { cost: 0.04 },
        providerCostUsd: 0.04,
        referenceImageCount: 1,
      },
    });
    expect(existsSync(join(projectDir, 'out/seedream.png'))).toBe(true);
    expect(readFileSync(join(projectDir, 'out/seedream.png'))).toEqual(imageBytes);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.dhee.test/api/cloud/media/image',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer desktop-token',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: 'bytedance-seed/seedream-4.5',
      prompt: 'A cinematic scooter product image',
      referenceImageUrls: [
        `data:image/png;base64,${Buffer.from('reference-image').toString('base64')}`,
      ],
      imageConfig: { output_format: 'png' },
    });
  });

  it('resolves modelInput and promptInput from project inputs', async () => {
    const prepared = await prepareDheeCloudImageRequest(
      makeCtx(
        {
          promptInput: 'segment_image_prompt',
          modelInput: 'imageModel',
          outputPath: 'out/image.png',
        },
        {
          segment_image_prompt: { imagePrompt: 'A compact documentary keyframe' },
          imageModel: 'bytedance-seed/seedream-4.5',
        },
      ),
    );

    expect(prepared.ok).toBe(true);
    expect(prepared.value.body).toMatchObject({
      model: 'bytedance-seed/seedream-4.5',
      prompt: 'A compact documentary keyframe',
    });
  });

  it('surfaces Dhee Cloud entitlement errors clearly', async () => {
    process.env.DHEE_CLOUD_URL = 'https://cloud.dhee.test';
    process.env.DHEE_CLOUD_TOKEN = 'desktop-token';
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: 'Hosted media not available',
          planId: 'starter_10',
        }),
        { status: 403, statusText: 'Forbidden' },
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runner.run(makeCtx({
      prompt: 'A blocked image',
      model: 'bytedance-seed/seedream-4.5',
      outputPath: 'out/image.png',
    }));

    expect(result).toEqual({
      ok: false,
      error:
        'dhee.cloud.image: Dhee Cloud request failed (403 Forbidden): Hosted media not available',
    });
  });
});
