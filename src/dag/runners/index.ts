/**
 * Runner registry bootstrap — registers all built-in runners into the
 * process-global RunnerRegistry at import time, and exposes the
 * legacy `getRunner` / `listRunners` API for back-compat with code
 * that hasn't migrated to using the registry directly.
 *
 * Custom runners (from ~/.kshana/runners/) are NOT loaded here — they
 * come in through `discoverRunners` at engine startup. See discovery.ts.
 */
import type { Runner } from '../schema.js';
import { comfyImageRunner } from './comfyImage.js';
import { comfyLtxDirectorRunner } from './comfyLtxDirector.js';
import { comfyQwenEditChainRunner } from './comfyQwenEditChain.js';
import { ffmpegConcatRunner } from './ffmpegConcat.js';
import { ffmpegShotClipRunner } from './ffmpegShotClip.js';
import { llmGenerateRunner } from './llmGenerate.js';
import { vlmJudgeRunner } from './vlmJudge.js';
import {
  getGlobalRegistry,
  type RunnerRegistry,
  type RunnerManifest,
} from './registry.js';
import { BUILTIN_RUNNER_MANIFESTS } from './builtinManifests.js';

export type { RunnerManifest } from './registry.js';
export {
  RunnerRegistry,
  getGlobalRegistry,
  __resetGlobalRegistryForTesting,
} from './registry.js';

// ── Manifests for the built-in runners ────────────────────────────────
// These describe the runners' versions, credential needs, and engine
// compatibility. They're paired with the runner instances and
// registered together.

const RUNNERS_BY_TOOL: Record<string, Runner> = {
  'llm.generate': llmGenerateRunner,
  'comfy.image': comfyImageRunner,
  'comfy.ltx_director': comfyLtxDirectorRunner,
  'comfy.qwen_edit_chain': comfyQwenEditChainRunner,
  'ffmpeg.concat': ffmpegConcatRunner,
  'ffmpeg.shot_clip': ffmpegShotClipRunner,
  'vlm.judge': vlmJudgeRunner,
};

const BUILTIN_MANIFESTS: Array<{ manifest: RunnerManifest; runner: Runner }> =
  BUILTIN_RUNNER_MANIFESTS.map((manifest) => {
    const runner = RUNNERS_BY_TOOL[manifest.tool];
    if (!runner) {
      throw new Error(`No built-in runner implementation for ${manifest.tool}`);
    }
    return { manifest, runner };
  });

// Auto-register at module load.
function bootstrap(reg: RunnerRegistry): void {
  for (const { manifest, runner } of BUILTIN_MANIFESTS) {
    reg.register(manifest, runner);
  }
}
bootstrap(getGlobalRegistry());

/**
 * Legacy lookup API. New code should call `getGlobalRegistry().get(tool)`
 * directly so the registry is explicit. Kept here so the existing
 * walker code doesn't need a same-PR refactor.
 */
export function getRunner(tool: string): Runner | undefined {
  return getGlobalRegistry().get(tool);
}

/** Legacy listing API. */
export function listRunners(): string[] {
  return getGlobalRegistry().list().map((m) => m.tool);
}
