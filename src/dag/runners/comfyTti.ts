/**
 * `comfy.tti` — text-to-image runner (Z-Image or any prompt-only workflow).
 *
 * The simple case: a prompt + dimensions, no reference images, no graph
 * pruning. Drives zimage_tti.json for character_image / setting_image.
 * All plumbing lives in comfyExecutor.
 */
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import {
  executeComfyWorkflow,
  defaultComfyClientFactory,
  type ComfyImageClient,
} from './comfyExecutor.js';

/** Prompt comes from config.prompt, else an upstream {imagePrompt} JSON, else a plain string input. */
function resolvePrompt(ctx: RunnerContext): string | undefined {
  const cfg = ctx.node.runner.config as Record<string, unknown>;
  if (typeof cfg['prompt'] === 'string') return cfg['prompt'] as string;
  for (const v of Object.values(ctx.inputs)) {
    if (v && typeof v === 'object' && typeof (v as { imagePrompt?: unknown }).imagePrompt === 'string') {
      return (v as { imagePrompt: string }).imagePrompt;
    }
  }
  for (const v of Object.values(ctx.inputs)) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

export function createComfyTtiRunner(opts?: {
  clientFactory?: (o: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultComfyClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'comfy.tti',
    displayName: 'Comfy text-to-image',
    description: 'Generates an image from a text prompt via a ComfyUI text-to-image workflow (no reference images).',
    capabilities: ['image-generation', 'text-to-image'],
    modalities: { input: ['text'], output: ['image'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath: { type: 'string' },
        manifestPath: { type: 'string' },
        parameterMappings: { type: 'array' },
        endpoint: { type: 'string' },
        prompt: { type: 'string' },
        outputPath: { type: 'string' },
        seed: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        forceRerun: { type: 'boolean' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as Record<string, unknown>;
    const prompt = resolvePrompt(ctx);

    const scalars: Record<string, unknown> = {};
    if (typeof cfg['width'] === 'number') scalars['width'] = cfg['width'];
    if (typeof cfg['height'] === 'number') scalars['height'] = cfg['height'];
    if (typeof cfg['seed'] === 'number') scalars['seed'] = cfg['seed'];

    return executeComfyWorkflow({
      ctx,
      tool: 'comfy.tti',
      workflowPath: cfg['workflowPath'] as string,
      ...(typeof cfg['manifestPath'] === 'string' ? { manifestPath: cfg['manifestPath'] as string } : {}),
      ...(Array.isArray(cfg['parameterMappings'])
        ? { parameterMappings: cfg['parameterMappings'] as never }
        : {}),
      ...(typeof cfg['endpoint'] === 'string' ? { endpoint: cfg['endpoint'] as string } : {}),
      outputPath: cfg['outputPath'] as string,
      ...(prompt !== undefined ? { prompt } : {}),
      imageInputs: {},
      scalars,
      ...(cfg['forceRerun'] === true ? { forceRerun: true } : {}),
      ...(typeof cfg['width'] === 'number' ? { width: cfg['width'] as number } : {}),
      ...(typeof cfg['height'] === 'number' ? { height: cfg['height'] as number } : {}),
      clientFactory,
    });
  }

  return { describe, run };
}

export const comfyTtiRunner = createComfyTtiRunner();
