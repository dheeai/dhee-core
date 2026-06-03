import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { defineRunner } from '@dhee/runner-sdk';
import type {
  RunnerContext,
  RunnerDescription,
  RunnerManifest,
  RunnerResult,
} from '@dhee/runner-sdk';

export const OPENROUTER_CHAT_COMPLETIONS_URL =
  'https://openrouter.ai/api/v1/chat/completions';

type ImageModality = 'image' | 'text';

interface OpenRouterRequest {
  model: string;
  messages: Array<{ role: 'user'; content: string }>;
  modalities: ImageModality[];
  stream: false;
  image_config?: Record<string, unknown>;
}

interface PreparedRequest {
  model: string;
  prompt: string;
  outputPath: string;
  outputAbs: string;
  body: OpenRouterRequest;
  requestedOutputFormat?: string;
}

type PreparedRequestResult =
  | { ok: true; value: PreparedRequest }
  | { ok: false; error: string };

type DecodedDataUrl =
  | { ok: true; mimeType: string; bytes: Buffer }
  | { ok: false; error: string };

export const manifest = {
  tool: 'openrouter.image',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  credentials: ['OPENROUTER_API_KEY'],
  displayName: 'OpenRouter Image',
  description: 'Generates image artifacts via OpenRouter image-capable models.',
  entry: 'dist/index.js',
  permissions: {
    network: ['openrouter.ai'],
    filesystem: 'project',
    subprocess: false,
    env: [
      'OPENROUTER_API_KEY',
      'OPENROUTER_IMAGE_MODEL',
      'OPENROUTER_HTTP_REFERER',
      'OPENROUTER_APP_TITLE',
    ],
  },
} satisfies RunnerManifest;

const DESCRIPTION: RunnerDescription = {
  id: manifest.tool,
  displayName: 'OpenRouter Image',
  description: 'Generates images with OpenRouter image-output models.',
  capabilities: ['image-generation', 'openrouter'],
  modalities: {
    input: ['text'],
    output: ['image'],
  },
  costHint: 'paid_api',
  configSchema: {
    type: 'object',
    required: ['prompt', 'model', 'outputPath'],
    properties: {
      prompt: {
        type: 'string',
        minLength: 1,
        description: 'Image generation prompt.',
      },
      model: {
        type: 'string',
        minLength: 1,
        description: 'OpenRouter image-capable model id.',
      },
      outputPath: {
        type: 'string',
        minLength: 1,
        description: 'Project-relative image output path injected by the walker.',
      },
      aspectRatio: {
        type: 'string',
        description: 'Optional OpenRouter image_config.aspect_ratio value.',
      },
      size: {
        type: 'string',
        description: 'Optional OpenRouter image_config.image_size value.',
      },
      imageSize: {
        type: 'string',
        description: 'Alias for size.',
      },
      outputFormat: {
        type: 'string',
        description: 'Expected output format metadata; OpenRouter returns a data URL.',
      },
      modalities: {
        type: 'array',
        items: { enum: ['image', 'text'] },
        description: 'Defaults to ["image", "text"]. Must include "image".',
      },
      imageConfig: {
        type: 'object',
        description: 'Optional advanced OpenRouter image_config pass-through.',
      },
    },
    additionalProperties: true,
  },
};

export const runner = defineRunner({
  describe: () => DESCRIPTION,
  run: runOpenRouterImage,
});

async function runOpenRouterImage(ctx: RunnerContext): Promise<RunnerResult> {
  const apiKey = readNonEmptyEnv('OPENROUTER_API_KEY');
  if (!apiKey) {
    return {
      ok: false,
      error: 'openrouter.image: missing OPENROUTER_API_KEY',
    };
  }
  if (typeof globalThis.fetch !== 'function') {
    return {
      ok: false,
      error: 'openrouter.image: global fetch is unavailable; Node.js 20+ is required',
    };
  }

  const prepared = prepareOpenRouterImageRequest(ctx);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const referer = readNonEmptyEnv('OPENROUTER_HTTP_REFERER');
  if (referer) headers['HTTP-Referer'] = referer;
  headers['X-Title'] = readNonEmptyEnv('OPENROUTER_APP_TITLE') ?? 'Dhee OpenRouter Image Runner';

  ctx.log(`openrouter.image: generating ${prepared.value.outputPath} with ${prepared.value.model}`);

  let response: Response;
  try {
    response = await globalThis.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepared.value.body),
      signal: ctx.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: `openrouter.image: request failed: ${errorMessage(err)}`,
    };
  }

  const parsed = await readJsonResponse(response);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (!response.ok) {
    const providerError = extractProviderError(parsed.value);
    return {
      ok: false,
      error: `openrouter.image: OpenRouter request failed (${response.status} ${response.statusText || 'HTTP error'}): ${providerError}`,
    };
  }

  const imageUrls = extractImageDataUrls(parsed.value);
  const firstImageUrl = imageUrls[0];
  if (!firstImageUrl) {
    return {
      ok: false,
      error: 'openrouter.image: OpenRouter response did not include choices[0].message.images',
    };
  }

  const decoded = decodeBase64DataUrl(firstImageUrl);
  if (!decoded.ok) return { ok: false, error: `openrouter.image: ${decoded.error}` };

  try {
    await mkdir(dirname(prepared.value.outputAbs), { recursive: true });
    await writeFile(prepared.value.outputAbs, decoded.bytes);
  } catch (err) {
    return {
      ok: false,
      error: `openrouter.image: failed to write ${prepared.value.outputPath}: ${errorMessage(err)}`,
    };
  }

  const responseId = readStringField(parsed.value, 'id');
  const assistantContent = extractAssistantContent(parsed.value);

  return {
    ok: true,
    outputPath: prepared.value.outputPath,
    outputs: [
      {
        path: prepared.value.outputPath,
        kind: 'image',
        metadata: {
          mimeType: decoded.mimeType,
          byteLength: decoded.bytes.byteLength,
        },
      },
    ],
    metadata: {
      provider: 'openrouter',
      model: prepared.value.model,
      responseId,
      mimeType: decoded.mimeType,
      byteLength: decoded.bytes.byteLength,
      imageCount: imageUrls.length,
      requestedOutputFormat: prepared.value.requestedOutputFormat,
      assistantContent,
    },
  };
}

export function prepareOpenRouterImageRequest(ctx: RunnerContext): PreparedRequestResult {
  const config = ctx.node.runner.config;
  const outputPath = readNonEmptyString(config, 'outputPath');
  if (!outputPath) {
    return { ok: false, error: 'openrouter.image: missing outputPath' };
  }

  const outputAbsResult = resolveProjectOutputPath(ctx.projectDir, outputPath);
  if (!outputAbsResult.ok) return outputAbsResult;

  const model = readNonEmptyString(config, 'model') ?? readNonEmptyEnv('OPENROUTER_IMAGE_MODEL');
  if (!model) {
    return {
      ok: false,
      error:
        'openrouter.image: missing model; set node.runner.config.model or OPENROUTER_IMAGE_MODEL',
    };
  }

  const prompt = resolvePrompt(config, ctx.inputs);
  if (!prompt) {
    return {
      ok: false,
      error: 'openrouter.image: missing prompt; set node.runner.config.prompt',
    };
  }

  const modalities = readModalities(config);
  if (typeof modalities === 'string') {
    return { ok: false, error: `openrouter.image: ${modalities}` };
  }

  const imageConfig = readImageConfig(config);
  if (!imageConfig.ok) return imageConfig;

  const aspectRatio = readNonEmptyString(config, 'aspectRatio');
  if (aspectRatio) imageConfig.value['aspect_ratio'] = aspectRatio;

  const imageSize = readNonEmptyString(config, 'imageSize') ?? readNonEmptyString(config, 'size');
  if (imageSize) imageConfig.value['image_size'] = imageSize;

  const body: OpenRouterRequest = {
    model,
    messages: [{ role: 'user', content: prompt }],
    modalities,
    stream: false,
  };
  if (Object.keys(imageConfig.value).length > 0) {
    body.image_config = imageConfig.value;
  }

  return {
    ok: true,
    value: {
      model,
      prompt,
      outputPath,
      outputAbs: outputAbsResult.value,
      body,
      requestedOutputFormat: readNonEmptyString(config, 'outputFormat'),
    },
  };
}

export function extractImageDataUrls(response: unknown): string[] {
  if (!isRecord(response) || !Array.isArray(response['choices'])) return [];

  const urls: string[] = [];
  for (const choice of response['choices']) {
    if (!isRecord(choice)) continue;
    const message = choice['message'];
    if (!isRecord(message) || !Array.isArray(message['images'])) continue;
    for (const image of message['images']) {
      if (!isRecord(image)) continue;
      const snake = image['image_url'];
      const camel = image['imageUrl'];
      const imageUrl = isRecord(snake) ? snake : isRecord(camel) ? camel : undefined;
      const url = imageUrl ? readNonEmptyString(imageUrl, 'url') : undefined;
      if (url) urls.push(url);
    }
  }
  return urls;
}

export function decodeBase64DataUrl(dataUrl: string): DecodedDataUrl {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  const mimeType = match?.[1];
  const encoded = match?.[2];
  if (!mimeType || !encoded) {
    return {
      ok: false,
      error: 'expected OpenRouter image_url.url to be a base64 data URL',
    };
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      error: 'decoded image data URL was empty',
    };
  }
  return { ok: true, mimeType, bytes };
}

function resolveProjectOutputPath(
  projectDir: string,
  outputPath: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (isAbsolute(outputPath)) {
    return {
      ok: false,
      error: `openrouter.image: outputPath must be project-relative: ${outputPath}`,
    };
  }

  const projectRoot = resolve(projectDir);
  const outputAbs = resolve(projectRoot, outputPath);
  const rel = relative(projectRoot, outputAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      error: `openrouter.image: outputPath escapes project directory: ${outputPath}`,
    };
  }
  return { ok: true, value: outputAbs };
}

function resolvePrompt(config: Record<string, unknown>, inputs: Record<string, unknown>): string | undefined {
  const configured = readNonEmptyString(config, 'prompt');
  if (configured) return configured;

  const promptInput = readNonEmptyString(config, 'promptInput');
  if (promptInput) {
    const selected = inputs[promptInput];
    if (typeof selected === 'string' && selected.trim().length > 0) return selected;
  }

  const inputPrompt = inputs['prompt'];
  if (typeof inputPrompt === 'string' && inputPrompt.trim().length > 0) return inputPrompt;
  return undefined;
}

function readImageConfig(
  config: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = config['imageConfig'];
  if (raw === undefined) return { ok: true, value: {} };
  if (!isRecord(raw)) {
    return { ok: false, error: 'openrouter.image: imageConfig must be an object when provided' };
  }
  return { ok: true, value: { ...raw } };
}

function readModalities(config: Record<string, unknown>): ImageModality[] | string {
  const raw = config['modalities'];
  if (raw === undefined) return ['image', 'text'];
  if (!Array.isArray(raw)) return 'modalities must be an array when provided';

  const modalities: ImageModality[] = [];
  const rawItems = raw as unknown[];
  for (const item of rawItems) {
    if (item !== 'image' && item !== 'text') {
      return 'modalities may only contain "image" and "text"';
    }
    const modality: ImageModality = item;
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  if (!modalities.includes('image')) return 'modalities must include "image"';
  return modalities;
}

async function readJsonResponse(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const raw = await response.text();
  if (raw.trim().length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    const prefix = raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
    return {
      ok: false,
      error: `openrouter.image: OpenRouter returned non-JSON response: ${prefix}`,
    };
  }
}

function extractProviderError(response: unknown): string {
  if (isRecord(response)) {
    const error = response['error'];
    if (typeof error === 'string' && error.trim().length > 0) return error;
    if (isRecord(error)) {
      const message = readNonEmptyString(error, 'message');
      if (message) return message;
      const code = readNonEmptyString(error, 'code');
      if (code) return code;
    }
  }
  return 'unknown provider error';
}

function extractAssistantContent(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response['choices'])) return undefined;
  const choices = response['choices'] as unknown[];
  const firstChoice = choices[0];
  if (!isRecord(firstChoice)) return undefined;
  const message = firstChoice['message'];
  if (!isRecord(message)) return undefined;
  return readNonEmptyString(message, 'content');
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return readNonEmptyString(value, key);
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNonEmptyEnv(key: string): string | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
