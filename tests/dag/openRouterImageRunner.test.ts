import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  decodeBase64DataUrl,
  extractImageDataUrls,
  manifest,
  prepareOpenRouterImageRequest,
  runner,
} from '../../packages/openrouter-image-runner/src/index.js';
import { discoverRunners } from '../../src/dag/runners/discovery.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import { walkBundle } from '../../src/dag/walker.js';
import type { DagBundle, RunnerContext } from '../../src/dag/schema.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '../..');
const SDK_ROOT = join(REPO_ROOT, 'packages/runner-sdk');
const RUNNER_ROOT = join(REPO_ROOT, 'packages/openrouter-image-runner');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_IMAGE_MODEL',
  'OPENROUTER_HTTP_REFERER',
  'OPENROUTER_APP_TITLE',
] as const;

let tempRoot: string | undefined;
let originalFetch: typeof globalThis.fetch;
let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'dhee-openrouter-runner-'));
  originalFetch = globalThis.fetch;
  envSnapshot = {};
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
});

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetGlobalRegistryForTesting();
  vi.restoreAllMocks();
});

function makeContext(
  config: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
): RunnerContext {
  if (!tempRoot) throw new Error('tempRoot not initialized');
  return {
    projectDir: tempRoot,
    node: {
      id: 'image',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'image', pattern: 'assets/images/out.png' },
      runner: {
        tool: 'openrouter.image',
        config,
      },
    },
    inputs,
    log: vi.fn(),
  };
}

function dataUrlFor(text: string, mimeType = 'image/png'): string {
  return `data:${mimeType};base64,${Buffer.from(text).toString('base64')}`;
}

function mockOpenRouterResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Bad Request',
      headers: { 'Content-Type': 'application/json' },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

function ensureRunnerBuilt(): void {
  if (!existsSync(join(SDK_ROOT, 'dist/index.js'))) {
    execFileSync(PNPM, ['-C', SDK_ROOT, 'run', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  }
  execFileSync(PNPM, ['-C', RUNNER_ROOT, 'run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
}

function installBuiltRunner(searchRoot: string): string {
  ensureRunnerBuilt();
  const runnerDir = join(searchRoot, 'openrouter-image-runner');
  mkdirSync(runnerDir, { recursive: true });
  copyFileSync(join(RUNNER_ROOT, 'runner.json'), join(runnerDir, 'runner.json'));
  cpSync(join(RUNNER_ROOT, 'dist'), join(runnerDir, 'dist'), { recursive: true });
  cpSync(join(RUNNER_ROOT, 'src'), join(runnerDir, 'src'), { recursive: true });

  const nodeModulesAtScope = join(runnerDir, 'node_modules/@dhee');
  mkdirSync(nodeModulesAtScope, { recursive: true });
  symlinkSync(SDK_ROOT, join(nodeModulesAtScope, 'runner-sdk'), 'dir');
  return runnerDir;
}

function readPackageJson(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(RUNNER_ROOT, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(abs));
    else if (entry.isFile() && abs.endsWith('.ts')) files.push(abs);
  }
  return files;
}

describe('@dhee/openrouter-image-runner', () => {
  it('declares the OpenRouter credential and permission boundary', () => {
    expect(manifest).toMatchObject({
      tool: 'openrouter.image',
      credentials: ['OPENROUTER_API_KEY'],
      permissions: {
        network: ['openrouter.ai'],
        filesystem: 'project',
        subprocess: false,
        env: expect.arrayContaining(['OPENROUTER_API_KEY']),
      },
    });

    const packageJson = readPackageJson();
    const dheeDeps = Object.keys(packageJson.dependencies ?? {}).filter((dep) =>
      dep.startsWith('@dhee/'),
    );
    expect(dheeDeps).toEqual(['@dhee/runner-sdk']);

    for (const file of listSourceFiles(join(RUNNER_ROOT, 'src'))) {
      expect(readFileSync(file, 'utf-8')).not.toMatch(/\.\.\/src|\.\.\/\.\.\/src|src\/dag|dhee-core/);
    }
  });

  it('fails clearly when OPENROUTER_API_KEY is missing', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await runner.run(
      makeContext({
        outputPath: 'assets/images/out.png',
        prompt: 'Generate a quiet mountain lake.',
        model: 'google/gemini-2.5-flash-image',
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'openrouter.image: missing OPENROUTER_API_KEY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds the OpenRouter request from node config', () => {
    process.env['OPENROUTER_IMAGE_MODEL'] = 'env/model';
    const prepared = prepareOpenRouterImageRequest(
      makeContext({
        outputPath: 'assets/images/out.png',
        prompt: 'Generate a quiet mountain lake.',
        aspectRatio: '16:9',
        size: '1K',
        outputFormat: 'png',
        imageConfig: {
          style: 'Photorealism',
        },
      }),
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.value.body).toEqual({
      model: 'env/model',
      messages: [{ role: 'user', content: 'Generate a quiet mountain lake.' }],
      modalities: ['image', 'text'],
      stream: false,
      image_config: {
        style: 'Photorealism',
        aspect_ratio: '16:9',
        image_size: '1K',
      },
    });
    expect(prepared.value.requestedOutputFormat).toBe('png');
  });

  it('posts to OpenRouter, decodes a data URL, and writes the output artifact', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    process.env['OPENROUTER_HTTP_REFERER'] = 'https://dhee.local';
    process.env['OPENROUTER_APP_TITLE'] = 'Dhee Test';

    const fetchMock = mockOpenRouterResponse({
      id: 'or-response-1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Generated one image.',
            images: [
              {
                type: 'image_url',
                image_url: { url: dataUrlFor('fake-png-bytes') },
              },
            ],
          },
        },
      ],
    });

    const result = await runner.run(
      makeContext({
        outputPath: 'assets/images/openrouter.png',
        prompt: 'A cinematic still of monsoon rain.',
        model: 'google/gemini-2.5-flash-image',
        aspectRatio: '16:9',
        size: '1K',
        outputFormat: 'png',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(readFileSync(join(tempRoot!, result.outputPath), 'utf-8')).toBe('fake-png-bytes');
    expect(result.outputs).toEqual([
      {
        path: 'assets/images/openrouter.png',
        kind: 'image',
        metadata: {
          mimeType: 'image/png',
          byteLength: 'fake-png-bytes'.length,
        },
      },
    ]);
    expect(result.metadata).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
      responseId: 'or-response-1',
      mimeType: 'image/png',
      imageCount: 1,
      requestedOutputFormat: 'png',
      assistantContent: 'Generated one image.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENROUTER_CHAT_COMPLETIONS_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dhee.local',
      'X-Title': 'Dhee Test',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'google/gemini-2.5-flash-image',
      messages: [{ role: 'user', content: 'A cinematic still of monsoon rain.' }],
      modalities: ['image', 'text'],
      stream: false,
      image_config: {
        aspect_ratio: '16:9',
        image_size: '1K',
      },
    });
  });

  it('returns a clear error when OpenRouter returns no images', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    mockOpenRouterResponse({
      id: 'or-response-empty',
      choices: [{ message: { role: 'assistant', content: 'No image here.' } }],
    });

    const result = await runner.run(
      makeContext({
        outputPath: 'assets/images/openrouter.png',
        prompt: 'A cinematic still of monsoon rain.',
        model: 'google/gemini-2.5-flash-image',
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'openrouter.image: OpenRouter response did not include choices[0].message.images',
    });
  });

  it('supports both raw OpenRouter snake_case and SDK camelCase image URL shapes', () => {
    expect(
      extractImageDataUrls({
        choices: [
          {
            message: {
              images: [
                { image_url: { url: dataUrlFor('snake') } },
                { imageUrl: { url: dataUrlFor('camel') } },
              ],
            },
          },
        ],
      }),
    ).toEqual([dataUrlFor('snake'), dataUrlFor('camel')]);

    expect(decodeBase64DataUrl(dataUrlFor('snake'))).toMatchObject({
      ok: true,
      mimeType: 'image/png',
      bytes: Buffer.from('snake'),
    });
  });

  it('discovers and runs the built package through the Dhee walker', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    const fetchMock = mockOpenRouterResponse({
      id: 'or-walker-response',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Walker image generated.',
            images: [{ image_url: { url: dataUrlFor('walker-image') } }],
          },
        },
      ],
    });

    const searchRoot = join(tempRoot!, 'runners');
    installBuiltRunner(searchRoot);

    const reg = getGlobalRegistry();
    await discoverRunners(reg, [searchRoot]);

    expect(reg.get('openrouter.image')).toBeDefined();
    expect(reg.getManifest('openrouter.image')?.permissions).toEqual({
      network: ['openrouter.ai'],
      filesystem: 'project',
      subprocess: false,
      env: [
        'OPENROUTER_API_KEY',
        'OPENROUTER_IMAGE_MODEL',
        'OPENROUTER_HTTP_REFERER',
        'OPENROUTER_APP_TITLE',
      ],
    });

    const bundle: DagBundle = {
      id: 'openrouter_image_bundle',
      version: '0.1.0',
      goal: 'image',
      dependencies: {
        runners: {
          'openrouter.image': '^0.1.0',
        },
      },
      nodes: [
        {
          id: 'image',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'image', pattern: 'assets/images/openrouter.png' },
          runner: {
            tool: 'openrouter.image',
            config: {
              prompt: 'A cinematic still of monsoon rain.',
              model: 'google/gemini-2.5-flash-image',
              aspectRatio: '16:9',
              size: '1K',
            },
          },
        },
      ],
    };

    expect(reg.validateBundle(bundle)).toEqual({ ok: true });

    const projectDir = join(tempRoot!, 'project');
    mkdirSync(projectDir, { recursive: true });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'assets/images/openrouter.png'), 'utf-8')).toBe(
      'walker-image',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const completed = result.instances.find((inst) => inst.def.id === 'image');
    expect(completed?.metadata).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash-image',
      responseId: 'or-walker-response',
      mimeType: 'image/png',
      imageCount: 1,
    });
  });
});
