#!/usr/bin/env tsx
/**
 * Run a DAG bundle against an existing project.
 *
 * Usage:
 *   pnpm tsx scripts/run-dag-bundle.ts <bundleIdOrPath> <projectDir> --scenes <ids>
 *
 * Examples:
 *   pnpm tsx scripts/run-dag-bundle.ts ltx_prompt_relay \
 *     "/Users/ganaraj/dhee-studios/Better Image - relay test" \
 *     --scenes 1
 *
 *   pnpm tsx scripts/run-dag-bundle.ts src/dag/bundles/ltx_prompt_relay.json \
 *     "/path/to/project" --scenes 1,2,3
 *
 * Defaults / behavior:
 *   - --scenes is a comma-separated list of scene numbers (e.g. "1" or "1,2,3")
 *   - Bundle paths are looked up in src/dag/bundles/<id>.json if no .json suffix
 *   - Endpoint routing is bundle-declared: each runner config has an
 *     `endpoint` name (e.g. "self.local") that resolves to the URL
 *     in the matching `ENDPOINT_<name>` env var (see .env). No global
 *     COMFY_MODE override happens here — the user's .env is in control.
 */
import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { walkBundle, loadBundle } from '../src/dag/walker.js';

// ── CLI parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error(
    'Usage: pnpm tsx scripts/run-dag-bundle.ts <bundleIdOrPath> <projectDir> --scenes <ids>',
  );
  process.exit(1);
}

const [bundleArg, projectArg] = args;
let scenesArg: string | undefined;
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--scenes') {
    scenesArg = args[i + 1];
    i++;
  }
}
if (!scenesArg) {
  console.error('Missing --scenes <ids> (comma-separated, e.g. "1" or "1,2,3")');
  process.exit(1);
}
const sceneIds = scenesArg.split(',').map((s) => parseInt(s.trim(), 10));
if (sceneIds.some((n) => !Number.isFinite(n) || n < 1)) {
  console.error(`Invalid --scenes value: ${scenesArg}`);
  process.exit(1);
}

const projectDir = resolve(projectArg!);
if (!existsSync(projectDir)) {
  console.error(`Project directory not found: ${projectDir}`);
  process.exit(1);
}

let bundlePath = bundleArg!;
if (!bundlePath.endsWith('.json')) {
  bundlePath = resolve(process.cwd(), `src/dag/bundles/${bundlePath}.json`);
} else if (!bundlePath.startsWith('/')) {
  bundlePath = resolve(process.cwd(), bundlePath);
}
if (!existsSync(bundlePath)) {
  console.error(`Bundle not found: ${bundlePath}`);
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────
const bundle = loadBundle(bundlePath);
console.log(`DAG bundle runner`);
console.log(`  bundle:  ${bundle.id} v${bundle.version}`);
console.log(`  project: ${projectDir}`);
console.log(`  scenes:  ${sceneIds.join(', ')}`);
console.log(`  comfy:   ${process.env['COMFYUI_BASE_URL']} (mode=${process.env['COMFY_MODE']})`);
console.log();

// Ensure log dir exists for any side-effecting writes.
mkdirSync(join(projectDir, 'logs'), { recursive: true });

const result = await walkBundle({
  projectDir,
  bundle,
  bundleSource: `built-in:${bundle.id}`,
  cli: { sceneIds },
});

if (!result.ok) {
  console.error(`\n✗ Bundle failed: ${result.error}`);
  console.error('\nNode statuses:');
  for (const inst of result.instances) {
    const id = inst.def.id + (inst.itemId ? `[${inst.itemId}]` : '');
    console.error(`  ${id}: ${inst.status}`);
  }
  process.exit(1);
}

console.log(`\n✓ Bundle complete.`);
console.log(`  Final video: ${result.goal!.outputAbs}`);
