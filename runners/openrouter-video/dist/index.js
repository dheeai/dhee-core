import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';

export const OPENROUTER_VIDEOS_URL = 'https://openrouter.ai/api/v1/videos';

export const manifest = {
  tool: 'openrouter.video',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  credentials: ['OPENROUTER_API_KEY'],
  displayName: 'OpenRouter Video',
  description: 'Generates video artifacts via OpenRouter asynchronous video generation.',
  entry: 'dist/index.js',
  permissions: {
    network: ['openrouter.ai'],
    filesystem: 'project',
    subprocess: false,
    env: [
      'OPENROUTER_API_KEY',
      'OPENROUTER_VIDEO_MODEL',
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
    capabilities: ['video-generation', 'image-to-video', 'openrouter'],
    modalities: { input: ['text', 'image'], output: ['video'] },
    costHint: 'paid_api',
    configSchema: {
      type: 'object',
      required: ['outputPath'],
      properties: {
        prompt: { type: 'string' },
        promptInput: { type: 'string' },
        firstFrameInput: { type: 'string' },
        firstFramePath: { type: 'string' },
        model: { type: 'string' },
        modelInput: { type: 'string' },
        outputPath: { type: 'string' },
        duration: { type: 'integer', minimum: 1 },
        resolution: { type: 'string' },
        aspectRatio: { type: 'string' },
        size: { type: 'string' },
        generateAudio: { type: 'boolean' },
        seed: { type: 'integer' },
        provider: { type: 'object' },
        pollIntervalMs: { type: 'integer', minimum: 1000 },
        maxPolls: { type: 'integer', minimum: 1 },
      },
      additionalProperties: true,
    },
  }),
  run: runOpenRouterVideo,
};

async function runOpenRouterVideo(ctx) {
  const apiKey = readNonEmptyEnv('OPENROUTER_API_KEY');
  if (!apiKey) return { ok: false, error: 'openrouter.video: missing OPENROUTER_API_KEY' };
  if (typeof globalThis.fetch !== 'function') {
    return {
      ok: false,
      error: 'openrouter.video: global fetch is unavailable; Node.js 20+ is required',
    };
  }

  const prepared = await prepareOpenRouterVideoRequest(ctx);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const headers = openRouterHeaders(apiKey);
  ctx.log?.(`openrouter.video: submitting ${prepared.value.outputPath} with ${prepared.value.model}`);

  let submitResponse;
  try {
    submitResponse = await globalThis.fetch(OPENROUTER_VIDEOS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(prepared.value.body),
      signal: ctx.signal,
    });
  } catch (err) {
    return { ok: false, error: `openrouter.video: submit failed: ${errorMessage(err)}` };
  }

  const submitted = await readJsonResponse(submitResponse, 'openrouter.video');
  if (!submitted.ok) return { ok: false, error: submitted.error };
  if (!submitResponse.ok) {
    return {
      ok: false,
      error: `openrouter.video: OpenRouter submit failed (${submitResponse.status} ${submitResponse.statusText || 'HTTP error'}): ${extractProviderError(submitted.value)}`,
    };
  }

  const jobId = readNonEmptyString(submitted.value, 'id');
  if (!jobId) return { ok: false, error: 'openrouter.video: submit response did not include id' };

  const pollingUrl =
    normalizeOpenRouterUrl(readNonEmptyString(submitted.value, 'polling_url'))
    ?? `${OPENROUTER_VIDEOS_URL}/${encodeURIComponent(jobId)}`;

  const maxPolls = readPositiveInteger(prepared.value.config, 'maxPolls') ?? 120;
  const pollIntervalMs = readPositiveInteger(prepared.value.config, 'pollIntervalMs') ?? 30000;

  let status = submitted.value;
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const currentStatus = readNonEmptyString(status, 'status');
    if (currentStatus === 'completed') break;
    if (['failed', 'cancelled', 'expired'].includes(currentStatus ?? '')) {
      return {
        ok: false,
        error: `openrouter.video: generation ${currentStatus}: ${extractProviderError(status)}`,
      };
    }
    await delay(pollIntervalMs, ctx.signal);
    let pollResponse;
    try {
      pollResponse = await globalThis.fetch(pollingUrl, {
        method: 'GET',
        headers,
        signal: ctx.signal,
      });
    } catch (err) {
      return { ok: false, error: `openrouter.video: poll failed: ${errorMessage(err)}` };
    }
    const polled = await readJsonResponse(pollResponse, 'openrouter.video');
    if (!polled.ok) return { ok: false, error: polled.error };
    if (!pollResponse.ok) {
      return {
        ok: false,
        error: `openrouter.video: OpenRouter poll failed (${pollResponse.status} ${pollResponse.statusText || 'HTTP error'}): ${extractProviderError(polled.value)}`,
      };
    }
    status = polled.value;
    ctx.log?.(`openrouter.video: ${jobId} status ${readNonEmptyString(status, 'status') ?? 'unknown'}`);
  }

  if (readNonEmptyString(status, 'status') !== 'completed') {
    return {
      ok: false,
      error: `openrouter.video: generation did not complete after ${maxPolls} polls`,
    };
  }

  const downloadUrl = pickDownloadUrl(status, jobId);
  if (!downloadUrl) {
    return { ok: false, error: 'openrouter.video: completed response did not include a video URL' };
  }

  let videoResponse;
  try {
    videoResponse = await globalThis.fetch(downloadUrl, {
      method: 'GET',
      headers: shouldAuthorizeDownload(downloadUrl) ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: ctx.signal,
    });
  } catch (err) {
    return { ok: false, error: `openrouter.video: download failed: ${errorMessage(err)}` };
  }
  if (!videoResponse.ok) {
    return {
      ok: false,
      error: `openrouter.video: download failed (${videoResponse.status} ${videoResponse.statusText || 'HTTP error'})`,
    };
  }

  const bytes = Buffer.from(await videoResponse.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { ok: false, error: 'openrouter.video: downloaded video was empty' };
  }

  try {
    await mkdir(dirname(prepared.value.outputAbs), { recursive: true });
    await writeFile(prepared.value.outputAbs, bytes);
  } catch (err) {
    return {
      ok: false,
      error: `openrouter.video: failed to write ${prepared.value.outputPath}: ${errorMessage(err)}`,
    };
  }

  const usage = isRecord(status.usage) ? status.usage : undefined;
  const requestedDurationSeconds = readPositiveInteger(prepared.value.config, 'duration');

  return {
    ok: true,
    outputPath: prepared.value.outputPath,
    outputs: [
      {
        path: prepared.value.outputPath,
        kind: 'video',
        metadata: {
          byteLength: bytes.byteLength,
          contentType: videoResponse.headers.get('Content-Type') ?? undefined,
        },
      },
    ],
    metadata: {
      provider: 'openrouter',
      model: prepared.value.model,
      jobId,
      generationId: readNonEmptyString(status, 'generation_id'),
      usage,
      usedFirstFrame: prepared.value.usedFirstFrame,
      requestedDurationSeconds,
      byteLength: bytes.byteLength,
    },
  };
}

export async function prepareOpenRouterVideoRequest(ctx) {
  const config = ctx.node?.runner?.config ?? {};
  const outputPath = readNonEmptyString(config, 'outputPath');
  if (!outputPath) return { ok: false, error: 'openrouter.video: missing outputPath' };

  const outputAbsResult = resolveProjectOutputPath(ctx.projectDir, outputPath, 'openrouter.video');
  if (!outputAbsResult.ok) return outputAbsResult;

  const model = resolveModel(config, ctx.inputs ?? {}, 'OPENROUTER_VIDEO_MODEL');
  if (!model) {
    return {
      ok: false,
      error: 'openrouter.video: missing model; set node.runner.config.model, modelInput, or OPENROUTER_VIDEO_MODEL',
    };
  }

  const prompt = resolvePrompt(config, ctx.inputs ?? {}, [
    'videoPrompt',
    'motionPrompt',
    'prompt',
    'description',
  ]);
  if (!prompt) {
    return {
      ok: false,
      error: 'openrouter.video: missing prompt; set node.runner.config.prompt or promptInput',
    };
  }

  const body = { model, prompt };
  copyInteger(config, body, 'duration');
  copyInteger(config, body, 'seed');
  copyString(config, body, 'resolution');
  copyString(config, body, 'size');
  const aspectRatio = readNonEmptyString(config, 'aspectRatio') ?? readNonEmptyString(config, 'aspect_ratio');
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (typeof config.generateAudio === 'boolean') body.generate_audio = config.generateAudio;
  if (isRecord(config.provider)) body.provider = config.provider;

  const firstFrameUrl = await resolveFirstFrameUrl(config, ctx.inputs ?? {}, ctx.projectDir);
  if (firstFrameUrl) {
    body.frame_images = [
      {
        type: 'image_url',
        image_url: { url: firstFrameUrl },
        frame_type: 'first_frame',
      },
    ];
  }

  return {
    ok: true,
    value: {
      config,
      model,
      prompt,
      outputPath,
      outputAbs: outputAbsResult.value,
      body,
      usedFirstFrame: Boolean(firstFrameUrl),
    },
  };
}

async function resolveFirstFrameUrl(config, inputs, projectDir) {
  const direct = readNonEmptyString(config, 'firstFrameUrl');
  if (direct) return direct;
  const configuredPath = readNonEmptyString(config, 'firstFramePath');
  const inputName = readNonEmptyString(config, 'firstFrameInput');
  const inputValue = inputName ? inputs[inputName] : undefined;
  const value = configuredPath ?? stringifyPathLike(inputValue);
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
  const abs = isAbsolute(value) ? value : resolve(projectDir, value);
  const bytes = await readFile(abs);
  return `data:${mimeTypeForPath(abs)};base64,${bytes.toString('base64')}`;
}

function stringifyPathLike(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (isRecord(value)) {
    return readNonEmptyString(value, 'path') ?? readNonEmptyString(value, 'url');
  }
  return undefined;
}

function pickDownloadUrl(status, jobId) {
  if (isRecord(status) && Array.isArray(status.unsigned_urls)) {
    const first = status.unsigned_urls.find((url) => typeof url === 'string' && url.trim());
    if (first) return normalizeOpenRouterUrl(first);
  }
  return `${OPENROUTER_VIDEOS_URL}/${encodeURIComponent(jobId)}/content?index=0`;
}

function openRouterHeaders(apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const referer = readNonEmptyEnv('OPENROUTER_HTTP_REFERER');
  if (referer) headers['HTTP-Referer'] = referer;
  headers['X-Title'] = readNonEmptyEnv('OPENROUTER_APP_TITLE') ?? 'Dhee OpenRouter Video Runner';
  return headers;
}

function normalizeOpenRouterUrl(value) {
  if (!value) return undefined;
  try {
    return new URL(value, 'https://openrouter.ai').toString();
  } catch {
    return undefined;
  }
}

function shouldAuthorizeDownload(url) {
  try {
    return new URL(url).hostname.endsWith('openrouter.ai');
  } catch {
    return false;
  }
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

function copyInteger(source, target, camelKey) {
  const value = readPositiveInteger(source, camelKey);
  if (value !== undefined) target[toSnakeCase(camelKey)] = value;
}

function copyString(source, target, camelKey) {
  const value = readNonEmptyString(source, camelKey);
  if (value) target[toSnakeCase(camelKey)] = value;
}

function toSnakeCase(value) {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function readPositiveInteger(record, key) {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return Number.isInteger(value) && value > 0 ? value : undefined;
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

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          rejectDelay(new Error('aborted'));
        },
        { once: true },
      );
    }
  });
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
