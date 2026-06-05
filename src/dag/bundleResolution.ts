/**
 * bundleResolution — per-endpoint, per-bundle "is this bundle
 * configured for this ComfyUI?" stamp. Sits next to workflowAliases
 * (same per-endpoint dir) so a bundle picker can show a
 * "✓ configured for this ComfyUI" badge without re-running the full
 * live checkBundle() probe on every render, and so a stale stamp is
 * invalidated when the bundle's version changes.
 *
 * Storage:
 *   <aliasesDir>/<endpoint-slug>/bundles/<bundleId>.json
 *
 *   {
 *     "bundleId": "...", "bundleVersion": "0.1.0",
 *     "endpoint": "...", "status": "ready",
 *     "modelsMissing": 0, "nodesMissing": 0, "resolvedAt": 1700000000000
 *   }
 *
 * The stamp is a CACHE, never the source of truth — checkBundle() is.
 * The desktop writes a stamp after the user resolves a bundle's gaps,
 * and reads it (cheaply) to badge the picker.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { endpointSlug } from './workflowAliases.js';
import type { BundleFitStatus } from './checkBundle.js';

export interface BundleResolution {
  bundleId: string;
  /** Bundle version at the time of resolution; a mismatch invalidates the stamp. */
  bundleVersion: string;
  endpoint: string;
  status: BundleFitStatus;
  modelsMissing: number;
  nodesMissing: number;
  /** Epoch ms when the stamp was written (caller supplies; keeps this module pure). */
  resolvedAt: number;
}

function resolutionPath(
  aliasesDir: string,
  endpoint: string,
  bundleId: string,
): { dir: string; file: string } {
  const dir = join(aliasesDir, endpointSlug(endpoint), 'bundles');
  return { dir, file: join(dir, `${bundleId}.json`) };
}

export function readBundleResolution(
  aliasesDir: string,
  endpoint: string,
  bundleId: string,
): BundleResolution | null {
  const { file } = resolutionPath(aliasesDir, endpoint, bundleId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BundleResolution;
  } catch {
    return null;
  }
}

export function writeBundleResolution(
  aliasesDir: string,
  resolution: BundleResolution,
): void {
  const { dir, file } = resolutionPath(aliasesDir, resolution.endpoint, resolution.bundleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(resolution, null, 2), 'utf8');
}

/**
 * True only when a stored stamp says the bundle is fully resolved
 * (`ready`) AND its version matches the current bundle. A version bump
 * (the bundle author changed a workflow) invalidates the stamp so the
 * UI re-checks rather than trusting a stale "configured" badge.
 */
export function isBundleResolved(
  aliasesDir: string,
  endpoint: string,
  bundleId: string,
  bundleVersion: string,
): boolean {
  const stamp = readBundleResolution(aliasesDir, endpoint, bundleId);
  return (
    stamp !== null &&
    stamp.status === 'ready' &&
    stamp.bundleVersion === bundleVersion
  );
}
