/**
 * workflowPathResolver — backend-aware resolution of a bundle-declared Comfy
 * `workflowPath` to an absolute file path.
 *
 * The engine has no runtime notion of `comfyBackend`; that is a desktop-level
 * concept that controls which `ENDPOINT_*` env vars are set. By the time a
 * runner runs, all it knows is the resolved endpoint URL (via
 * `resolveEndpointUrl`). So backend-aware workflow selection keys off that URL:
 * when it points at Comfy Cloud, a cloud variant of the graph is preferred.
 *
 * Cloud variant selection (first match wins):
 *   1. explicit `workflowPathCloud` (if its file resolves to disk), else
 *   2. convention: `..._local.json` → `..._cloud.json` (only if that file
 *      resolves to disk).
 * Falls back to the canonical path whenever no cloud candidate resolves — so
 * runners/bundles without a cloud variant are completely unaffected.
 *
 * Final absolute resolution: a `/`-absolute path passes through; otherwise
 * bundle-relative if it exists, else REPO_ROOT-relative. This generalizes the
 * per-runner `resolveWorkflowPath` helpers and unifies the bundle-relative +
 * REPO_ROOT fallback that the director already used.
 *
 * Pure w.r.t. the filesystem (existsSync reads only). No mutation.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../agent/pi/paths.js';
import { isCloudEndpoint } from './workflowAliases.js';

export interface ResolveWorkflowPathOpts {
  /** Canonical (typically local) workflow path — bundle-relative or absolute. */
  workflowPath: string;
  /** ctx.bundleDir — the root used to resolve bundle-relative paths. */
  bundleDir?: string;
  /**
   * Resolved endpoint URL (from `resolveEndpointUrl`). When this is a Comfy
   * Cloud endpoint, a cloud variant is preferred. Omit/undefined to disable
   * cloud routing entirely.
   */
  endpointUrl?: string;
  /** Explicit cloud variant path. Wins over the `_local→_cloud` convention. */
  workflowPathCloud?: string;
}

/** Resolve a relative-or-absolute path to an absolute path that exists on disk. */
function resolveAbsolutePath(relOrAbs: string, bundleDir?: string): string {
  if (relOrAbs.startsWith('/')) return relOrAbs;
  const bundleRel = bundleDir ? resolve(bundleDir, relOrAbs) : undefined;
  return bundleRel && existsSync(bundleRel) ? bundleRel : resolve(REPO_ROOT, relOrAbs);
}

/** True when `relOrAbs` resolves to an existing file (bundle-rel then REPO_ROOT). */
function resolvesExisting(relOrAbs: string, bundleDir?: string): boolean {
  if (relOrAbs.startsWith('/')) return existsSync(relOrAbs);
  if (bundleDir && existsSync(resolve(bundleDir, relOrAbs))) return true;
  return existsSync(resolve(REPO_ROOT, relOrAbs));
}

/**
 * Decide which relative/absolute path to load: a cloud variant when the
 * endpoint is cloud AND a cloud file resolves; otherwise the canonical path.
 */
function pickWorkflowPath(opts: ResolveWorkflowPathOpts): string {
  const { workflowPath, bundleDir, endpointUrl, workflowPathCloud } = opts;
  if (!endpointUrl || !isCloudEndpoint(endpointUrl)) return workflowPath;
  if (workflowPathCloud && resolvesExisting(workflowPathCloud, bundleDir)) {
    return workflowPathCloud;
  }
  const derived = workflowPath.replace(/_local(?=\.json$)/, '_cloud');
  if (derived !== workflowPath && resolvesExisting(derived, bundleDir)) {
    return derived;
  }
  return workflowPath;
}

/**
 * Resolve a bundle-declared workflowPath to an absolute file path, preferring
 * a cloud variant when the endpoint is Comfy Cloud. See module doc.
 */
export function resolveWorkflowPath(opts: ResolveWorkflowPathOpts): string {
  return resolveAbsolutePath(pickWorkflowPath(opts), opts.bundleDir);
}

/** True iff the endpoint URL targets Comfy Cloud. Re-exported for runners. */
export { isCloudEndpoint };
