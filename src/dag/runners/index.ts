/**
 * Runner registry — looks up a runner by its `tool` id.
 */
import type { Runner } from '../schema.js';
import { comfyLtxDirectorRunner } from './comfyLtxDirector.js';
import { ffmpegConcatRunner } from './ffmpegConcat.js';

const REGISTRY: Record<string, Runner> = {
  'comfy.ltx_director': comfyLtxDirectorRunner,
  'ffmpeg.concat': ffmpegConcatRunner,
};

export function getRunner(tool: string): Runner | undefined {
  return REGISTRY[tool];
}

export function listRunners(): string[] {
  return Object.keys(REGISTRY);
}
