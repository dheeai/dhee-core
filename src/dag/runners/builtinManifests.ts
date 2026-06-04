import type { RunnerManifest } from './registry.js';

export const BUILTIN_RUNNER_MANIFESTS: RunnerManifest[] = [
  {
    tool: 'llm.generate',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'LLM Generate',
    description:
      'Universal LLM runner. Renders a prompt template with variable substitution, calls the routed LLM at the declared tier, and writes markdown or schema-validated JSON to the output path.',
  },
  {
    tool: 'comfy.image',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'Comfy Image',
    description:
      'Generates a single image via a ComfyUI workflow. Handles uploads, parameter injection from bundle config + manifest, and output download.',
  },
  {
    tool: 'comfy.ltx_director',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'Comfy LTX Director',
    description:
      'Drives the LTX Director / Director Chain ComfyUI workflow to render per-scene relay clips from first-frame anchors + motion directives.',
  },
  {
    tool: 'comfy.qwen_edit_chain',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'Comfy Qwen Edit chain',
    description:
      'Qwen Image Edit chain for consistent character and setting continuity across sequential shots.',
  },
  {
    tool: 'ffmpeg.concat',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'ffmpeg concat',
    description:
      'Concatenates input video clips into a single final video, optionally with audio overlay and watermark.',
  },
  {
    tool: 'ffmpeg.shot_clip',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'ffmpeg shot clip (stub)',
    description:
      'Synthesizes an MP4 clip for one shot from a shot_breakdown entry.',
  },
  {
    tool: 'vlm.judge',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    credentials: [],
    displayName: 'VLM judge (review)',
    description:
      'Sends an image to a vision-language model for pass/fail review and critique-driven reruns.',
  },
];
