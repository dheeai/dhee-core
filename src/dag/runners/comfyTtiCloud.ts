/**
 * `comfy.tti.cloud` — Comfy Cloud-pinned variant of `comfy.tti`.
 *
 * Why this exists: the generic `comfy.tti` routes through the bundle-declared
 * `endpoint` label (e.g. "public.cloud"). That label only resolves when the
 * operator has set the matching `ENDPOINT_public_cloud` env var. In the common
 * Cloud plan the operator sets `COMFYUI_BASE_URL` + `COMFY_CLOUD_API_KEY` but
 * leaves `ENDPOINT_public_cloud` blank — so comfy.tti fails with
 * "endpoint 'public.cloud' is referenced but ENDPOINT_public_cloud is not set".
 *
 * This variant is SELF-CONTAINED for cloud. Before delegating to the same
 * zimage plumbing comfy.tti uses, it guarantees the cloud routing
 * preconditions the executor reads from env:
 *   - forces COMFY_MODE=cloud (so resolveEndpointUrl honors named endpoints),
 *   - defaults ENDPOINT_public_cloud → cloud.comfy.org/api when unset
 *     (honoring COMFYUI_BASE_URL if it already points at cloud.comfy.org),
 *   - fails fast with a clear RunnerResult error when COMFY_CLOUD_API_KEY
 *     is absent (never throws).
 *
 * The env defaults are idempotent + non-clobbering: an explicit operator
 * config always wins; only missing values are filled. Same workflow, manifest,
 * and CAS cache as comfy.tti.
 */
import { createComfyTtiRunner } from './comfyTti.js';
import type { Runner } from '../schema.js';
import type { ComfyImageClient } from './comfyExecutor.js';

const CLOUD_DEFAULT_BASE = 'https://cloud.comfy.org/api';

function meaningful(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * Ensure the cloud routing preconditions the executor reads from env.
 * Idempotent and non-clobbering: an explicit operator config (COMFY_MODE /
 * ENDPOINT_public_cloud / COMFYUI_BASE_URL) always wins.
 */
function ensureCloudEnv(): void {
  if (process.env['COMFY_MODE'] !== 'cloud') process.env['COMFY_MODE'] = 'cloud';
  if (!meaningful(process.env['ENDPOINT_public_cloud'])) {
    const base = process.env['COMFYUI_BASE_URL'];
    process.env['ENDPOINT_public_cloud'] =
      meaningful(base) && base.includes('cloud.comfy.org') ? base.trim() : CLOUD_DEFAULT_BASE;
  }
}

export function createComfyTtiCloudRunner(opts?: {
  clientFactory?: (o: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const inner = createComfyTtiRunner(opts);
  return {
    describe: () => {
      const d = inner.describe();
      return { ...d, id: 'comfy.tti.cloud', displayName: 'Comfy text-to-image (Cloud)' };
    },
    async run(ctx) {
      ensureCloudEnv();
      if (!meaningful(process.env['COMFY_CLOUD_API_KEY'])) {
        return {
          ok: false,
          error:
            'comfy.tti.cloud: COMFY_CLOUD_API_KEY is not set. Comfy Cloud (cloud.comfy.org) requires it as X-API-Key.',
        };
      }
      return inner.run(ctx);
    },
  };
}

export const comfyTtiCloudRunner = createComfyTtiCloudRunner();
