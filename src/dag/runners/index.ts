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
import { comfyKleinRunner } from './comfyKlein.js';
import { comfyTtiRunner } from './comfyTti.js';
import { comfyFl2vRunner } from './comfyFl2v.js';
import { comfyLtxDirectorRunner } from './comfyLtxDirector.js';
import { comfyQwenEditChainRunner } from './comfyQwenEditChain.js';
import { ffmpegConcatRunner } from './ffmpegConcat.js';
import { ffmpegShotClipRunner } from './ffmpegShotClip.js';
import { ffmpegKenBurnsRunner } from './ffmpegKenBurns.js';
import { ffmpegOverlayRunner } from './ffmpegOverlay.js';
import { ffmpegDemoOverlayRunner } from './ffmpegDemoOverlay.js';
import { llmGenerateRunner } from './llmGenerate.js';
import { vlmJudgeRunner } from './vlmJudge.js';
// Dhee Cloud media runners — first-party runners for the Dhee Cloud media
// proxy lane (image/video generation via /api/cloud/media/*). Implemented
// as committed dist modules under runners/dhee-cloud-* (same shape as the
// @dhee_ai/openrouter-runners npm package, which remains the distributable
// copy for external hosts).
import { manifest as dheeCloudImageManifest, runner as dheeCloudImageRunner } from '../../../runners/dhee-cloud-image/dist/index.js';
import { manifest as dheeCloudVideoManifest, runner as dheeCloudVideoRunner } from '../../../runners/dhee-cloud-video/dist/index.js';
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
    // Bound to the Flux 2 Klein edit workflow. Endpoint URL resolved at
    // runner.run() time from ENDPOINT_<name> env (same as the other comfy
    // runners), validated with an actionable error pointing at Settings.
    manifest: {
      tool: 'comfy.klein',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'Comfy Klein (Flux 2 reference edit)',
      description:
        'Drives the Flux 2 Klein edit workflow: a base reference image plus up to 3 optional references threaded through a ReferenceLatent chain. Absent optional references are pruned from the graph; uploads + parameter injection + output download handled by the shared executor.',
    },
    runner: comfyKleinRunner,
  },
  {
    manifest: {
      tool: 'comfy.tti',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'Comfy text-to-image',
      description:
        'Generates an image from a text prompt via a ComfyUI text-to-image workflow (no reference images). Used for character / setting reference renders.',
    },
    runner: comfyTtiRunner,
  },
  {
    manifest: {
      tool: 'comfy.fl2v',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'Comfy first/last-frame to video',
      description:
        'Renders a short video from a required first frame, an optional last frame, and a motion prompt via a ComfyUI FL2V workflow.',
    },
    runner: comfyFl2vRunner,
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
      tool: 'comfy.qwen_edit_chain',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'Comfy Qwen Edit chain',
      description:
        'Qwen Image Edit 2511 + Multi-Angle LoRA + Lightning 4-step LoRA. Iteratively edits a prior shot (LLM-picked from previousN candidates) into the next shot via camera-rotation guidance. Enables consistent character/setting continuity across a scene at low cost.',
    },
    runner: comfyQwenEditChainRunner,
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
  {
    manifest: {
      tool: 'ffmpeg.shot_clip',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'ffmpeg shot clip (stub)',
      description:
        'Synthesizes a 10s MP4 clip for one shot from a shot_breakdown entry. Stand-in for the real LTX video runner — produces real binary artifacts (animated colored boxes; no text overlay) so end-to-end tests flow real videos through events + CAS + branches without needing GPU.',
    },
    runner: ffmpegShotClipRunner,
  },
  {
    manifest: {
      tool: 'ffmpeg.kenburns',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'ffmpeg Ken Burns',
      description:
        'Animates one still image with a subtle Ken Burns zoom/pan and muxes narration audio, sized to that audio. Keeps text-heavy stills (infographics, slides) pixel-sharp — unlike generative video.',
    },
    runner: ffmpegKenBurnsRunner,
  },
  {
    manifest: {
      tool: 'ffmpeg.overlay',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'ffmpeg Overlay',
      description:
        'Composites an overlay image onto a base video (PiP / screen inset) deterministically — overlaid pixels are byte-exact after a clean resize, never regenerated by a model.',
    },
    runner: ffmpegOverlayRunner,
  },
  {
    manifest: {
      tool: 'ffmpeg.demo_overlay',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'ffmpeg Demo Overlay',
      description:
        'Talking-head clip with a pixel-exact screenshot that pops in as a top-right inset, expands to fullscreen, holds, then collapses back — deterministic, lip-sync preserved.',
    },
    runner: ffmpegDemoOverlayRunner,
  },
  {
    manifest: {
      tool: 'vlm.judge',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      displayName: 'VLM judge (review)',
      description:
        'Sends an image to a vision-language model for pass/fail review. On fail, stamps pendingCritiques[refineNode:itemId] so the walker’s review-loop wrapper invalidates the upstream prompt-LLM and re-walks with the critique applied. Verdict JSON is written to outputPath. VLM endpoint resolved from runner config or VLM_PROVIDER/VLM_API_KEY/VLM_MODEL env. Pair with bundle-level reviewLoopMax to bound retry budget per dispatch.',
    },
    runner: vlmJudgeRunner,
  },
  {
    manifest: dheeCloudImageManifest,
    runner: dheeCloudImageRunner,
  },
  {
    manifest: dheeCloudVideoManifest,
    runner: dheeCloudVideoRunner,
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
