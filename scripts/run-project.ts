#!/usr/bin/env tsx
/**
 * Run a project end-to-end. Reads `project.json` → `renderMethod` and
 * dispatches to the appropriate path (shot_by_shot or prompt_relay).
 *
 * Usage:
 *   pnpm tsx scripts/run-project.ts <projectDir> [options]
 *
 * Options:
 *   --method <id>     Override the project's declared renderMethod for
 *                     this run only. Doesn't persist. Valid: shot_by_shot,
 *                     prompt_relay.
 *   --scenes <ids>    For prompt_relay: comma-separated scene numbers
 *                     (e.g. "1" or "1,2,3"). Defaults to all scenes.
 *   --bundle <id>     For prompt_relay: which bundle JSON to use.
 *                     Defaults to 'ltx_prompt_relay'.
 *
 * Examples:
 *   pnpm tsx scripts/run-project.ts /path/to/my_project
 *     → runs whatever renderMethod is set in project.json
 *
 *   pnpm tsx scripts/run-project.ts /path/to/my_project --method prompt_relay
 *     → one-off override; project.json untouched
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runProjectInProcess } from '../src/server/runners/runProjectInProcess.js';
import {
  resolveRenderMethod,
  RENDER_METHOD_IDS,
} from '../src/core/project/renderMethods.js';

// Force local LTX endpoint — the prompt-relay branch needs it. The
// unconditional override mirrors run-dag-bundle.ts: the user's .env
// often has COMFY_MODE=cloud as a default, which would break relay.
// Pass DAG_BUNDLE_COMFY_KEEP_ENV=1 to disable this override.
if (!process.env['DAG_BUNDLE_COMFY_KEEP_ENV']) {
  process.env['COMFY_MODE'] = 'local';
  process.env['COMFYUI_BASE_URL'] =
    process.env['COMFY_LOCAL_URL'] ?? 'http://192.168.68.108:8188';
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    'Usage: pnpm tsx scripts/run-project.ts <projectDir> [--method <id>] [--scenes <ids>] [--bundle <id>]',
  );
  process.exit(1);
}

const projectDir = resolve(args[0]!);
if (!existsSync(projectDir)) {
  console.error(`Project directory not found: ${projectDir}`);
  process.exit(1);
}

let methodOverride: ReturnType<typeof resolveRenderMethod> = null;
let scenesArg: string | undefined;
let bundleId: string | undefined;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--method') {
    const r = resolveRenderMethod(args[i + 1]);
    if (!r) {
      console.error(
        `Invalid --method '${args[i + 1]}'. Valid: ${RENDER_METHOD_IDS.join(', ')}`,
      );
      process.exit(1);
    }
    methodOverride = r;
    i++;
  } else if (args[i] === '--scenes') {
    scenesArg = args[i + 1];
    i++;
  } else if (args[i] === '--bundle') {
    bundleId = args[i + 1];
    i++;
  }
}

const scenes = scenesArg
  ? scenesArg.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0)
  : undefined;

console.log(`runProject`);
console.log(`  project:  ${projectDir}`);
console.log(`  comfy:    ${process.env['COMFYUI_BASE_URL']} (mode=${process.env['COMFY_MODE']})`);
if (methodOverride) console.log(`  override: --method ${methodOverride}`);
if (scenes) console.log(`  scenes:   ${scenes.join(', ')}`);
if (bundleId) console.log(`  bundle:   ${bundleId}`);
console.log();

const result = await runProjectInProcess({
  projectDir,
  ...(methodOverride ? { methodOverride } : {}),
  ...(scenes ? { scenes } : {}),
  ...(bundleId ? { bundleId } : {}),
});

console.log();
console.log(`=== runProject finished (method=${result.method}) ===`);
console.log(`  ok:            ${result.ok}`);
if (result.error) console.log(`  error:         ${result.error}`);
if (result.finalVideoAbs) console.log(`  final video:   ${result.finalVideoAbs}`);
console.log(`  executor:      status=${result.executor?.status ?? '?'}`);
if (result.bundle) {
  console.log(`  bundle:        ok=${result.bundle.ok}${result.bundle.outputPath ? ` outputPath=${result.bundle.outputPath}` : ''}`);
}

process.exit(result.ok ? 0 : 1);
