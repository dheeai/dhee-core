import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';

export const manifest = {
  tool: 'dhee.cloud.video',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  credentials: ['DHEE_CLOUD_URL', 'DHEE_CLOUD_TOKEN'],
  displayName: 'Dhee Cloud Video',
  description: 'Generates video artifacts through the Dhee Cloud media proxy.',
  entry: 'dist/index.js',
  permissions: {
    network: ['dhee.ai', 'localhost', '127.0.0.1'],
    filesystem: 'project',
    subprocess: false,
    env: ['DHEE_CLOUD_URL', 'DHEE_CLOUD_TOKEN', 'DHEE_CLOUD_VIDEO_MODEL'],
  },
};

export const runner = {
  describe: () => ({
    id: manifest.tool,
    displayName: manifest.displayName,
    description: manifest.description,
    capabilities: ['video-generation', 'image-to-video', 'dhee-cloud'],
    modalities: { input: ['text', 'image'], output: ['video'] },
    costHint: 'dhee_cloud_credits',
    configSchema: {
      type: 'object',
      required: ['outputPath'],
      properties: {
        prompt: { type: 'string' },
        promptInput: { type: 'string' },
        firstFrameInput: { type: 'string' },
        firstFramePath: { type: 'string' },
        firstFrameUrl: { type: 'string' },
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
        pollIntervalMs: { type: 'integer', minimum: 1 },
        maxPolls: { type: 'integer', minimum: 1 },
      },
      additionalProperties: true,
    },
  }),
  run: runDheeCloudVideo,
};

async function runDheeCloudVideo(ctx) {
  const cloud = resolveDheeCloudEnv('dhee.cloud.video');
  if (!cloud.ok) return { ok: false, error: cloud.error };
  if (typeof globalThis.fetch !== 'function') {
    return {
      ok: false,
      error: 'dhee.cloud.video: global fetch is unavailable; Node.js 20+ is required',
    };
  }

  const prepared = await prepareDheeCloudVideoRequest(ctx);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  ctx.log?.(`dhee.cloud.video: generating ${prepared.value.outputPath} with ${prepared.value.model}`);

  let response;
  try {
    response = await globalThis.fetch(joinUrl(cloud.url, '/api/cloud/media/video'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cloud.token}`,
      },
      body: JSON.stringify(prepared.value.body),
      signal: ctx.signal,
    });
  } catch (err) {
    return { ok: false, error: `dhee.cloud.video: request failed: ${errorMessage(err)}` };
  }

  const parsed = await readJsonResponse(response, 'dhee.cloud.video');
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!response.ok) {
    return {
      ok: false,
      error: `dhee.cloud.video: Dhee Cloud request failed (${response.status} ${response.statusText || 'HTTP error'}): ${readProviderError(parsed.value)}`,
    };
  }

  const artifact = readArtifactDataUrl(parsed.value);
  if (!artifact.ok) return { ok: false, error: `dhee.cloud.video: ${artifact.error}` };
  const decoded = decodeBase64DataUrl(artifact.value);
  if (!decoded.ok) return { ok: false, error: `dhee.cloud.video: ${decoded.error}` };

  try {
    await mkdir(dirname(prepared.value.outputAbs), { recursive: true });
    await writeFile(prepared.value.outputAbs, decoded.bytes);
  } catch (err) {
    return {
      ok: false,
      error: `dhee.cloud.video: failed to write ${prepared.value.outputPath}: ${errorMessage(err)}`,
    };
  }

  const metadata = isRecord(parsed.value.metadata) ? parsed.value.metadata : {};
  return {
    ok: true,
    outputPath: prepared.value.outputPath,
    outputs: [
      {
        path: prepared.value.outputPath,
        kind: 'video',
        metadata: {
          mimeType: decoded.mimeType,
          byteLength: decoded.bytes.byteLength,
        },
      },
    ],
    metadata: {
      ...metadata,
      provider: 'dhee-cloud',
      upstreamProvider: metadata.provider ?? 'openrouter',
      model: prepared.value.model,
      usedFirstFrame: prepared.value.usedFirstFrame,
      requestedDurationSeconds: readPositiveInteger(prepared.value.config, 'duration'),
      mimeType: decoded.mimeType,
      byteLength: decoded.bytes.byteLength,
    },
  };
}

export async function prepareDheeCloudVideoRequest(ctx) {
  const config = ctx.node?.runner?.config ?? {};
  const outputPath = readNonEmptyString(config, 'outputPath');
  if (!outputPath) return { ok: false, error: 'dhee.cloud.video: missing outputPath' };

  const outputAbsResult = resolveProjectOutputPath(ctx.projectDir, outputPath, 'dhee.cloud.video');
  if (!outputAbsResult.ok) return outputAbsResult;

  const model = resolveModel(config, ctx.inputs ?? {}, 'DHEE_CLOUD_VIDEO_MODEL');
  if (!model) {
    return {
      ok: false,
      error: 'dhee.cloud.video: missing model; set node.runner.config.model, modelInput, or DHEE_CLOUD_VIDEO_MODEL',
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
      error: 'dhee.cloud.video: missing prompt; set node.runner.config.prompt or promptInput',
    };
  }

  const body = { model, prompt };
  copyInteger(config, body, 'duration');
  copyInteger(config, body, 'seed');
  copyInteger(config, body, 'pollIntervalMs');
  copyInteger(config, body, 'maxPolls');
  copyString(config, body, 'resolution');
  copyString(config, body, 'size');
  copyString(config, body, 'aspectRatio');
  if (typeof config.generateAudio === 'boolean') body.generateAudio = config.generateAudio;
  if (isRecord(config.provider)) body.provider = config.provider;

  const firstFrameUrl = await resolveFirstFrameUrl(config, ctx.inputs ?? {}, ctx.projectDir);
  if (firstFrameUrl) body.firstFrameUrl = firstFrameUrl;

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

function resolveDheeCloudEnv(label) {
  const url = readNonEmptyEnv('DHEE_CLOUD_URL') ?? readNonEmptyEnv('dhee_CLOUD_URL');
  if (!url) return { ok: false, error: `${label}: missing DHEE_CLOUD_URL` };
  const token = readNonEmptyEnv('DHEE_CLOUD_TOKEN') ?? readNonEmptyEnv('dhee_CLOUD_TOKEN');
  if (!token) return { ok: false, error: `${label}: missing DHEE_CLOUD_TOKEN` };
  return { ok: true, url, token };
}

function joinUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
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
  try {
    const bytes = await readFile(abs);
    if (bytes.byteLength === 0) return undefined;
    return `data:${mimeTypeForPath(abs)};base64,${bytes.toString('base64')}`;
  } catch (err) {
    throw new Error(`dhee.cloud.video: failed to read first frame ${value}: ${errorMessage(err)}`);
  }
}

function stringifyPathLike(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (isRecord(value)) {
    return (
      readNonEmptyString(value, 'path') ??
      readNonEmptyString(value, 'url') ??
      readNonEmptyString(value, 'outputPath') ??
      readNonEmptyString(value, 'filePath')
    );
  }
  return undefined;
}

function readArtifactDataUrl(value) {
  if (!isRecord(value) || !isRecord(value.artifact)) {
    return { ok: false, error: 'Dhee Cloud response did not include artifact' };
  }
  const dataUrl = readNonEmptyString(value.artifact, 'dataUrl');
  if (dataUrl) return { ok: true, value: dataUrl };
  const base64 = readNonEmptyString(value.artifact, 'base64');
  const mimeType = readNonEmptyString(value.artifact, 'mimeType') ?? 'video/mp4';
  if (base64) return { ok: true, value: `data:${mimeType};base64,${base64}` };
  return { ok: false, error: 'Dhee Cloud response artifact was empty' };
}

export function decodeBase64DataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  const mimeType = match?.[1];
  const encoded = match?.[2];
  if (!mimeType || !encoded) {
    return { ok: false, error: 'expected artifact to be a base64 data URL' };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) return { ok: false, error: 'decoded artifact was empty' };
  return { ok: true, mimeType, bytes };
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
  if (value !== undefined) target[camelKey] = value;
}

function copyString(source, target, camelKey) {
  const value = readNonEmptyString(source, camelKey);
  if (value) target[camelKey] = value;
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
    const contentType = response.headers?.get?.('content-type');
    const contentHint = contentType ? ` (${contentType})` : '';
    const snippet = responseBodySnippet(raw);
    if (!response.ok) {
      return {
        ok: false,
        error:
          `${label}: Dhee Cloud request failed ` +
          `(${response.status} ${response.statusText || 'HTTP error'}) ` +
          `with non-JSON response${contentHint}${snippet ? `: ${snippet}` : ''}`,
      };
    }
    return {
      ok: false,
      error:
        `${label}: response was not valid JSON${contentHint}` +
        `${snippet ? `: ${snippet}` : ''}`,
    };
  }
}

function responseBodySnippet(raw) {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function readProviderError(body) {
  if (!isRecord(body)) return 'Unknown cloud error';
  const message = body.message ?? body.error;
  if (typeof message === 'string' && message.trim()) return message;
  return 'Unknown cloud error';
}

function mimeTypeForPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
