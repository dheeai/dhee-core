/**
 * `comfy.fl2v` — first-frame / last-frame → video runner.
 *
 * Bound to the FL2V cloud workflow (fl2v_cloud.json): a required first
 * frame, an optional last frame, a motion prompt, and a duration. Drives
 * shot_video in narrative_shot_by_shot. All plumbing lives in
 * comfyExecutor; this runner only resolves its named inputs.
 *
 * Input-source convention (this is a bound runner, so it is allowed to
 * know it): first frame ← upstream `shot_image`, last frame ← upstream
 * `shot_image_last_frame`, motion prompt ← `shot_motion_directive`.
 * Config can override each explicitly.
 */
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import {
  executeComfyWorkflow,
  defaultComfyClientFactory,
  type ComfyImageClient,
} from './comfyExecutor.js';

const DEFAULT_DURATION_SECONDS = 3;

function resolvePrompt(ctx: RunnerContext): string | undefined {
  const cfg = ctx.node.runner.config as Record<string, unknown>;
  if (typeof cfg['prompt'] === 'string') return cfg['prompt'] as string;
  // FL2V motion prompt comes from the motion directive's `description`.
  const md = ctx.inputs['shot_motion_directive'];
  if (md && typeof md === 'object' && typeof (md as { description?: unknown }).description === 'string') {
    return (md as { description: string }).description;
  }
  for (const v of Object.values(ctx.inputs)) {
    if (v && typeof v === 'object' && typeof (v as { imagePrompt?: unknown }).imagePrompt === 'string') {
      return (v as { imagePrompt: string }).imagePrompt;
    }
  }
  return undefined;
}

export function createComfyFl2vRunner(opts?: {
  clientFactory?: (o: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultComfyClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'comfy.fl2v',
    displayName: 'Comfy first/last-frame to video',
    description:
      'Renders a short video from a required first frame, an optional last frame, and a motion prompt via a ComfyUI FL2V workflow.',
    capabilities: ['video-generation', 'first-last-frame'],
    modalities: { input: ['text', 'image'], output: ['video'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath: { type: 'string' },
        manifestPath: { type: 'string' },
        workflowId: { type: 'string' },
        parameterMappings: { type: 'array' },
        endpoint: { type: 'string' },
        prompt: { type: 'string' },
        firstFrame: { type: 'string' },
        lastFrame: { type: 'string' },
        outputPath: { type: 'string' },
        seed: { type: 'integer' },
        duration: { type: 'number' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        forceRerun: { type: 'boolean' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as Record<string, unknown>;
    const prompt = resolvePrompt(ctx);

    // Image inputs: first_frame (required), last_frame (optional).
    const imageInputs: Record<string, string> = {};
    const firstFrame =
      (typeof cfg['firstFrame'] === 'string' ? (cfg['firstFrame'] as string) : undefined) ??
      (typeof ctx.inputs['shot_image'] === 'string' ? (ctx.inputs['shot_image'] as string) : undefined);
    const lastFrame =
      (typeof cfg['lastFrame'] === 'string' ? (cfg['lastFrame'] as string) : undefined) ??
      (typeof ctx.inputs['shot_image_last_frame'] === 'string'
        ? (ctx.inputs['shot_image_last_frame'] as string)
        : undefined);
    if (firstFrame) imageInputs['first_frame'] = firstFrame;
    if (lastFrame) imageInputs['last_frame'] = lastFrame;

    const scalars: Record<string, unknown> = {
      durationSeconds: typeof cfg['duration'] === 'number' ? (cfg['duration'] as number) : DEFAULT_DURATION_SECONDS,
    };
    if (typeof cfg['negativePrompt'] === 'string') scalars['negative_prompt'] = cfg['negativePrompt'];
    if (typeof cfg['loraStrength'] === 'number') scalars['lora_strength'] = cfg['loraStrength'];
    if (typeof cfg['width'] === 'number') scalars['width'] = cfg['width'];
    if (typeof cfg['height'] === 'number') scalars['height'] = cfg['height'];
    if (typeof cfg['seed'] === 'number') scalars['seed'] = cfg['seed'];

    return executeComfyWorkflow({
      ctx,
      tool: 'comfy.fl2v',
      workflowPath: cfg['workflowPath'] as string,
      ...(typeof cfg['manifestPath'] === 'string' ? { manifestPath: cfg['manifestPath'] as string } : {}),
      ...(Array.isArray(cfg['parameterMappings'])
        ? { parameterMappings: cfg['parameterMappings'] as never }
        : {}),
      ...(typeof cfg['endpoint'] === 'string' ? { endpoint: cfg['endpoint'] as string } : {}),
      ...(typeof cfg['workflowId'] === 'string' ? { workflowId: cfg['workflowId'] as string } : {}),
      outputPath: cfg['outputPath'] as string,
      ...(prompt !== undefined ? { prompt } : {}),
      imageInputs,
      scalars,
      durationSeconds: scalars['durationSeconds'] as number,
      ...(cfg['forceRerun'] === true ? { forceRerun: true } : {}),
      ...(typeof cfg['width'] === 'number' ? { width: cfg['width'] as number } : {}),
      ...(typeof cfg['height'] === 'number' ? { height: cfg['height'] as number } : {}),
      clientFactory,
    });
  }

  return { describe, run };
}

export const comfyFl2vRunner = createComfyFl2vRunner();
