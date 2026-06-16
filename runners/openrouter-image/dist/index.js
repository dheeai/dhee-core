import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';

export const OPENROUTER_CHAT_COMPLETIONS_URL =
  'https://openrouter.ai/api/v1/chat/completions';

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
};

export const runner = {
  describe: () => ({
    id: manifest.tool,
    displayName: manifest.displayName,
    description: manifest.description,
    capabilities: ['image-generation', 'openrouter'],
    modalities: { input: ['text', 'image'], output: ['image'] },
    costHint: 'paid_api',
    configSchema: {
      type: 'object',
      required: ['outputPath'],
      properties: {
        prompt: { type: 'string' },
        promptInput: { type: 'string' },
        model: { type: 'string' },
        modelInput: { type: 'string' },
        outputPath: { type: 'string' },
        referenceImageInput: { type: 'string' },
        referenceImagePath: { type: 'string' },
        referenceImagePaths: {
          type: 'array',
          items: { type: 'string' },
        },
        referenceImageUrl: { type: 'string' },
        referenceImageUrls: {
          type: 'array',
          items: { type: 'string' },
        },
        aspectRatio: { type: 'string' },
        size: { type: 'string' },
        imageSize: { type: 'string' },
        outputFormat: { type: 'string' },
        modalities: {
          type: 'array',
          items: { enum: ['image', 'text'] },
        },
        imageConfig: { type: 'object' },
      },
      additionalProperties: true,
    },
  }),
  run: runOpenRouterImage,
};

async function runOpenRouterImage(ctx) {
  const apiKey = readNonEmptyEnv('OPENROUTER_API_KEY');
  if (!apiKey) return { ok: false, error: 'openrouter.image: missing OPENROUTER_API_KEY' };
  if (typeof globalThis.fetch !== 'function') {
    return {
      ok: false,
      error: 'openrouter.image: global fetch is unavailable; Node.js 20+ is required',
    };
  }

  const prepared = await prepareOpenRouterImageRequest(ctx);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const referer = readNonEmptyEnv('OPENROUTER_HTTP_REFERER');
  if (referer) headers['HTTP-Referer'] = referer;
  headers['X-Title'] = readNonEmptyEnv('OPENROUTER_APP_TITLE') ?? 'Dhee OpenRouter Image Runner';

  ctx.log?.(`openrouter.image: generating ${prepared.value.outputPath} with ${prepared.value.model}`);

  let response;
  try {
    response = await globalThis.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepared.value.body),
      signal: ctx.signal,
    });
  } catch (err) {
    return { ok: false, error: `openrouter.image: request failed: ${errorMessage(err)}` };
  }

  const parsed = await readJsonResponse(response, 'openrouter.image');
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!response.ok) {
    return {
      ok: false,
      error: `openrouter.image: OpenRouter request failed (${response.status} ${response.statusText || 'HTTP error'}): ${extractProviderError(parsed.value)}`,
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
  const usage = isRecord(parsed.value.usage) ? parsed.value.usage : undefined;

  try {
    await mkdir(dirname(prepared.value.outputAbs), { recursive: true });
    await writeFile(prepared.value.outputAbs, decoded.bytes);
  } catch (err) {
    return {
      ok: false,
      error: `openrouter.image: failed to write ${prepared.value.outputPath}: ${errorMessage(err)}`,
    };
  }

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
      responseId: readStringField(parsed.value, 'id'),
      usage,
      mimeType: decoded.mimeType,
      byteLength: decoded.bytes.byteLength,
      imageCount: imageUrls.length,
      requestedOutputFormat: prepared.value.requestedOutputFormat,
      assistantContent: extractAssistantContent(parsed.value),
      referenceImageCount: prepared.value.referenceImageCount,
    },
  };
}

export async function prepareOpenRouterImageRequest(ctx) {
  const config = ctx.node?.runner?.config ?? {};
  const outputPath = readNonEmptyString(config, 'outputPath');
  if (!outputPath) return { ok: false, error: 'openrouter.image: missing outputPath' };

  const outputAbsResult = resolveProjectOutputPath(ctx.projectDir, outputPath, 'openrouter.image');
  if (!outputAbsResult.ok) return outputAbsResult;

  const model = resolveModel(config, ctx.inputs ?? {}, 'OPENROUTER_IMAGE_MODEL');
  if (!model) {
    return {
      ok: false,
      error: 'openrouter.image: missing model; set node.runner.config.model, modelInput, or OPENROUTER_IMAGE_MODEL',
    };
  }

  const prompt = resolvePrompt(config, ctx.inputs ?? {}, [
    'imagePrompt',
    'prompt',
    'description',
    'visualThesis',
  ]);
  if (!prompt) {
    return {
      ok: false,
      error: 'openrouter.image: missing prompt; set node.runner.config.prompt or promptInput',
    };
  }

  const referenceImages = await resolveReferenceImageUrls(config, ctx.inputs ?? {}, ctx.projectDir);
  if (!referenceImages.ok) return referenceImages;

  const modalities = readModalities(config, model);
  if (typeof modalities === 'string') return { ok: false, error: `openrouter.image: ${modalities}` };

  const imageConfig = readObject(config, 'imageConfig') ?? {};
  const aspectRatio = readNonEmptyString(config, 'aspectRatio');
  if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
  const imageSize = readNonEmptyString(config, 'imageSize') ?? readNonEmptyString(config, 'size');
  if (imageSize) imageConfig.image_size = imageSize;

  const messageContent = referenceImages.value.length > 0
    ? [
        { type: 'text', text: prompt },
        ...referenceImages.value.map((url) => ({
          type: 'image_url',
          image_url: { url },
        })),
      ]
    : prompt;
  const body = {
    model,
    messages: [{ role: 'user', content: messageContent }],
    modalities,
    stream: false,
  };
  if (Object.keys(imageConfig).length > 0) body.image_config = imageConfig;

  return {
    ok: true,
    value: {
      model,
      prompt,
      outputPath,
      outputAbs: outputAbsResult.value,
      body,
      requestedOutputFormat: readNonEmptyString(config, 'outputFormat'),
      referenceImageCount: referenceImages.value.length,
    },
  };
}

export function extractImageDataUrls(response) {
  if (!isRecord(response) || !Array.isArray(response.choices)) return [];
  const urls = [];
  for (const choice of response.choices) {
    if (!isRecord(choice)) continue;
    const message = choice.message;
    if (!isRecord(message) || !Array.isArray(message.images)) continue;
    for (const image of message.images) {
      if (!isRecord(image)) continue;
      const imageUrl = isRecord(image.image_url)
        ? image.image_url
        : isRecord(image.imageUrl)
          ? image.imageUrl
          : undefined;
      const url = imageUrl ? readNonEmptyString(imageUrl, 'url') : undefined;
      if (url) urls.push(url);
    }
  }
  return urls;
}

export function decodeBase64DataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  const mimeType = match?.[1];
  const encoded = match?.[2];
  if (!mimeType || !encoded) {
    return { ok: false, error: 'expected OpenRouter image_url.url to be a base64 data URL' };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) return { ok: false, error: 'decoded image data URL was empty' };
  return { ok: true, mimeType, bytes };
}

function readModalities(config, model) {
  const raw = config.modalities;
  if (raw === undefined) return defaultModalitiesForModel(model);
  if (!Array.isArray(raw)) return 'modalities must be an array when provided';
  const out = [];
  for (const item of raw) {
    if (item !== 'image' && item !== 'text') return 'modalities may only contain "image" and "text"';
    if (!out.includes(item)) out.push(item);
  }
  if (!out.includes('image')) return 'modalities must include "image"';
  return out;
}

function defaultModalitiesForModel(model) {
  const normalized = String(model ?? '').trim().toLowerCase();
  if (/^bytedance-seed\/seedream(?:-|$)/.test(normalized)) return ['image'];
  return ['image', 'text'];
}

function resolvePrompt(config, inputs, objectFields) {
  const configured = readNonEmptyString(config, 'prompt');
  if (configured) return configured;
  const promptInput = readNonEmptyString(config, 'promptInput');
  if (promptInput) return stringifyPromptValue(inputs[promptInput], objectFields);
  return stringifyPromptValue(inputs.prompt, objectFields);
}

function resolveModel(config, inputs, envKey) {
  const configured = readNonEmptyString(config, 'model');
  if (configured) return configured;
  const modelInput = readNonEmptyString(config, 'modelInput');
  if (modelInput) {
    const selected = inputs[modelInput];
    if (typeof selected === 'string' && selected.trim().length > 0) return selected.trim();
    if (isRecord(selected)) {
      return readNonEmptyString(selected, 'model') ?? readNonEmptyString(selected, 'id');
    }
  }
  return readNonEmptyEnv(envKey);
}

async function resolveReferenceImageUrls(config, inputs, projectDir) {
  const candidates = [
    ...readStringArray(config, 'referenceImageUrls'),
    ...readStringArray(config, 'referenceImages'),
  ];
  const directUrl = readNonEmptyString(config, 'referenceImageUrl');
  if (directUrl) candidates.push(directUrl);
  candidates.push(...readStringArray(config, 'referenceImagePaths'));
  const configuredPath = readNonEmptyString(config, 'referenceImagePath');
  if (configuredPath) candidates.push(configuredPath);

  const inputName = readNonEmptyString(config, 'referenceImageInput');
  if (inputName) {
    candidates.push(...collectPathLikes(inputs[inputName]));
  }

  const urls = [];
  for (const candidate of candidates) {
    const resolved = await resolveImageUrl(candidate, projectDir);
    if (!resolved.ok) return resolved;
    urls.push(resolved.value);
  }
  return { ok: true, value: urls };
}

async function resolveImageUrl(value, projectDir) {
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) {
    return { ok: true, value };
  }
  if (!projectDir) return { ok: false, error: 'openrouter.image: missing projectDir' };
  const abs = isAbsolute(value) ? value : resolve(projectDir, value);
  try {
    const bytes = await readFile(abs);
    if (bytes.byteLength === 0) {
      return { ok: false, error: `openrouter.image: reference image was empty: ${value}` };
    }
    return {
      ok: true,
      value: `data:${mimeTypeForPath(abs)};base64,${bytes.toString('base64')}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `openrouter.image: failed to read reference image ${value}: ${errorMessage(err)}`,
    };
  }
}

function collectPathLikes(value) {
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap((item) => collectPathLikes(item));
  if (isRecord(value)) {
    const direct = readNonEmptyString(value, 'path') ?? readNonEmptyString(value, 'url');
    if (direct) return [direct];
  }
  return [];
}

function readStringArray(record, key) {
  if (!isRecord(record) || !Array.isArray(record[key])) return [];
  return record[key]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
}

function stringifyPromptValue(value, objectFields) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (isRecord(value)) {
    for (const field of objectFields) {
      const candidate = readNonEmptyString(value, field);
      if (candidate) return candidate;
    }
    return JSON.stringify(value);
  }
  return undefined;
}

function resolveProjectOutputPath(projectDir, outputPath, label) {
  if (!projectDir) return { ok: false, error: `${label}: missing projectDir` };
  if (isAbsolute(outputPath)) {
    return { ok: false, error: `${label}: outputPath must be project-relative: ${outputPath}` };
  }
  const projectRoot = resolve(projectDir);
  const outputAbs = resolve(projectRoot, outputPath);
  const rel = relative(projectRoot, outputAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `${label}: outputPath escapes project directory: ${outputPath}` };
  }
  return { ok: true, value: outputAbs };
}

async function readJsonResponse(response, label) {
  const raw = await response.text();
  if (raw.trim().length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: `${label}: OpenRouter returned non-JSON response: ${raw.slice(0, 240)}` };
  }
}

function extractProviderError(response) {
  if (!isRecord(response)) return 'unknown provider error';
  if (typeof response.error === 'string' && response.error.trim()) return response.error;
  if (isRecord(response.error)) {
    return readNonEmptyString(response.error, 'message')
      ?? readNonEmptyString(response.error, 'code')
      ?? 'unknown provider error';
  }
  return 'unknown provider error';
}

function extractAssistantContent(response) {
  const first = isRecord(response) && Array.isArray(response.choices) ? response.choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  return isRecord(message) ? readNonEmptyString(message, 'content') : undefined;
}

function readStringField(value, key) {
  return isRecord(value) ? readNonEmptyString(value, key) : undefined;
}

function readObject(record, key) {
  const value = record[key];
  return isRecord(value) ? { ...value } : undefined;
}

function mimeTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.png':
    default:
      return 'image/png';
  }
}

function readNonEmptyString(record, key) {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonEmptyEnv(key) {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
