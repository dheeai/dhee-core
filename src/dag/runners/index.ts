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
import { comfyLtxDirectorRunner } from './comfyLtxDirector.js';
import { ffmpegConcatRunner } from './ffmpegConcat.js';
import { llmGenerateRunner } from './llmGenerate.js';
import {
  RunnerRegistry,
  getGlobalRegistry,
  type RunnerManifest,
} from './registry.js';

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

const BUILTIN_MANIFESTS: Array<{ manifest: RunnerManifest; runner: Runner }> = [
  {
    manifest: {
      tool: 'llm.generate',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      // No required env credentials at the runner level — the LLM
      // provider's API key is read by the LLMRouter from user
      // settings / env (OPENAI_API_KEY etc.), and the router's own
      // error path surfaces "missing credentials for tier X" with a
      // useful message. Listing them here would duplicate the gate
      // and force every bundle to declare credentials it doesn't
      // actually know about.
      credentials: [],
      displayName: 'LLM Generate',
      description:
        'Universal LLM runner. Renders a prompt template with variable substitution, calls the routed LLM at the declared tier, and writes markdown or schema-validated JSON to the output path.',
    },
    runner: llmGenerateRunner,
  },
  {
    manifest: {
      tool: 'comfy.ltx_director',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      // No env credentials — the runner resolves its Comfy endpoint by
      // semantic name (e.g. self.local) through ENDPOINT_<name> vars,
      // which are user-config and validated at runner.run() time with a
      // clear pointer to which env var to set.
      credentials: [],
      displayName: 'Comfy LTX Director',
      description:
        'Drives the LTX Director / Director Chain ComfyUI workflow to render per-scene relay clips from first-frame anchors + motion directives.',
    },
    runner: comfyLtxDirectorRunner,
  },
  {
    manifest: {
      tool: 'ffmpeg.concat',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'ffmpeg concat',
      description:
        'Concatenates input video clips into a single final video, optionally with audio overlay and watermark.',
    },
    runner: ffmpegConcatRunner,
  },
];

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
