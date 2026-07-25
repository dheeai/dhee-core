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
import { ffmpegConcatRunner } from './ffmpegConcat.js';
// `cv.captions` REMOVED — it is superseded by the external `video.captions`
// (dhee-runner-presenter), and its source was never committed here, so this
// import broke the build on every clone but this one (#202). The legacy source
// is preserved at dhee-runner-presenter `reference/cv-captions-legacy.ts` as
// the input for porting its `asrEngine:'llm'` + `translateTo` paths (#196).
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

// ffmpeg.kenburns / ffmpeg.overlay / ffmpeg.demo_overlay moved OUT to
// dhee-runner-ffmpeg-composite (#195, and #187 for overlay) — one package, since
// demoOverlay imports kenBurns. They must NOT be registered here: ecosystem.ts
// skips a tool already in the registry, so a leftover built-in silently SHADOWS
// the external package (the 4e7bf411 bug).
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
  // comfy.klein RETIRED — not externalized. Its only real code was a node-id
  // prune table, which is now DATA in each bundle's klein.manifest.json
  // editConfig, driven by the external comfy.image_edit. Verified: identical
  // pruned graphs for 0-3 present references, including the transitive 2-hop
  // and 3-hop redirect cases and non-contiguous holes. Same play as comfy.boogu.
  // comfy.tti RETIRED — not externalized into its own package. A text-to-image
  // workflow is just an image workflow with ZERO input images, so the external
  // comfy.image_edit serves it from the same manifest-driven engine (v0.7.0),
  // with editConfig.imageSlots: []. Verified: identical submitted graphs on both
  // tti workflow variants. Registering it here would SHADOW that package.
  // comfy.fl2v DELETED — zero usage anywhere. No external bundle node referenced
  // it, and its only consumer was the built-in narrative_shot_by_shot, which had
  // 0 of 91 projects and is archived. Nothing to externalize.
  // comfy.ltx_director moved OUT of core into its own external runner package
  // (dhee-runner-ltx-director) — discovered at startup like the other
  // dhee-runner-* packages. Bundles declaring `comfy.ltx_director` resolve it
  // from there. See the open-runner-ecosystem convention.
  // comfy.qwen_edit_chain moved OUT of core into its own external package
  // (dhee-runner-qwen-edit-chain) — discovered at startup like the other
  // dhee-runner-* packages. It must NOT be registered here: ecosystem.ts skips a
  // tool already in the registry, so a leftover built-in silently SHADOWS the
  // external runner (the bug 4e7bf411 fixed for comfy.ltx_director).
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
  // ffmpeg.shot_clip DELETED — a TEST stub, never a product runner. Zero external
  // bundle nodes; its only consumer was the archived narrative_text_video. The
  // GPU-free "real video bytes" role belongs in tests/fixtures (#192), not in the
  // shipped registry.
  // plan.assemble DELETED — dead code, not externalized. Zero bundles dispatch
  // it: every consumer moved to the EXTERNAL plan.assemble_keyframes
  // (dhee-runner-plan-keyframes), which documents itself as "a STRICT SUPERSET
  // of dhee-core's built-in plan.assemble" and ships a parity suite asserting
  // byte-identical output at keyframe ceiling 1. So the behaviour is still
  // guarded — just not here. (#197's "one consumer" premise was stale.)
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
