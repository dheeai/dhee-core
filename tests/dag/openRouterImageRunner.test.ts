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

import { prepareOpenRouterImageRequest, runner } from '../../runners/openrouter-image/dist/index.js';

let projectDir: string;
let originalEnv: NodeJS.ProcessEnv;

function makeCtx(config: Record<string, unknown>) {
  return {
    projectDir,
    node: {
      id: 'seedream_image',
      runner: {
        tool: 'openrouter.image',
        config,
      },
    },
    inputs: {},
    log: vi.fn(),
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'openrouter-image-'));
  originalEnv = { ...process.env };
  vi.unstubAllGlobals();
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('openrouter.image runner', () => {
  it('returns a clear error when OPENROUTER_API_KEY is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;

    const result = await runner.run(makeCtx({
      prompt: 'A clean studio product shot',
      model: 'bytedance-seed/seedream-4.5',
      outputPath: 'out/image.png',
    }));

    expect(result).toEqual({
      ok: false,
      error: 'openrouter.image: missing OPENROUTER_API_KEY',
    });
  });

  it('builds a Seedream 4.5 request, writes the image artifact, and returns usage cost', async () => {
    process.env.OPENROUTER_API_KEY = 'or_key';
    mkdirSync(join(projectDir, 'refs'), { recursive: true });
    writeFileSync(join(projectDir, 'refs/source.png'), Buffer.from('reference-image'));

    const imageBytes = Buffer.from('generated-image');
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl_seedream',
          usage: { cost: 0.04 },
          choices: [
            {
              message: {
                content: 'Generated image.',
                images: [
                  {
                    image_url: {
                      url: `data:image/png;base64,${imageBytes.toString('base64')}`,
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
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
        provider: 'openrouter',
        model: 'bytedance-seed/seedream-4.5',
        responseId: 'chatcmpl_seedream',
        referenceImageCount: 1,
      },
    });
    expect(result.metadata.usage).toEqual({ cost: 0.04 });
    expect(existsSync(join(projectDir, 'out/seedream.png'))).toBe(true);
    expect(readFileSync(join(projectDir, 'out/seedream.png'))).toEqual(imageBytes);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer or_key');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'bytedance-seed/seedream-4.5',
      modalities: ['image'],
      stream: false,
      image_config: { output_format: 'png' },
    });
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'A cinematic scooter product image' },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from('reference-image').toString('base64')}`,
        },
      },
    ]);
  });

  it('keeps text and image modalities for Gemini-style image models by default', async () => {
    const prepared = await prepareOpenRouterImageRequest(makeCtx({
      prompt: 'A compact documentary keyframe',
      model: 'google/gemini-2.5-flash-image',
      outputPath: 'out/gemini.png',
    }));

    expect(prepared.ok).toBe(true);
    expect(prepared.value.body).toMatchObject({
      model: 'google/gemini-2.5-flash-image',
      modalities: ['image', 'text'],
      stream: false,
    });
  });

  it('preserves explicitly configured modalities', async () => {
    const prepared = await prepareOpenRouterImageRequest(makeCtx({
      prompt: 'A compact documentary keyframe',
      model: 'google/gemini-2.5-flash-image',
      outputPath: 'out/image.png',
      modalities: ['image'],
    }));

    expect(prepared.ok).toBe(true);
    expect(prepared.value.body.modalities).toEqual(['image']);
  });
});
