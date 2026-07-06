import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import '../src/dag/runners/index.js';
import { loadDevEnv } from '../src/server/loadDevEnv.js';
import { getGlobalRegistry } from '../src/dag/runners/registry.js';
import { runProjectViaBundle } from '../src/server/runners/runProjectViaBundle.js';

async function registerLocalRunners(): Promise<void> {
  const root = process.env.KSHANA_RUNNERS_DIR || join(homedir(), '.kshana/runners');
  const reg = getGlobalRegistry();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'runner.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entry?: string };
    const entry = resolve(dir, manifest.entry || 'index.mjs');
    if (!existsSync(entry)) continue;
    const mod = await import(pathToFileURL(entry).href);
    const pairs = Array.isArray(mod.runners)
      ? mod.runners
      : mod.runner
        ? [{ manifest: mod.manifest || manifest, runner: mod.runner }]
        : [];
    for (const pair of pairs) {
      if (pair?.manifest?.tool && pair?.runner?.run) reg.register(pair.manifest, pair.runner);
    }
  }
  console.log(`registered runners: ${reg.list().map((m) => m.tool).sort().join(', ')}`);
}

async function main(): Promise<void> {
  loadDevEnv();
  await registerLocalRunners();
  const [projectDir] = process.argv.slice(2);
  if (!projectDir) {
    console.error('usage: tsx scripts/run-local-runners.ts <projectDir>');
    process.exit(2);
  }
  const result = await runProjectViaBundle({
    projectDir,
    log: (m) => console.log(m),
  });
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.finalVideoAbs) console.log(`Final video: ${result.finalVideoAbs}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
