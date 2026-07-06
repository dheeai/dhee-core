import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import '../src/dag/runners/index.js';
import { loadDevEnv } from '../src/server/loadDevEnv.js';
import { getGlobalRegistry } from '../src/dag/runners/registry.js';
import { dheeRegenerateNodeTool } from '../src/agent/pi/tools/index.js';

type ToolOut = {
  content?: Array<{ text?: string }>;
  isError?: boolean;
};

type LooseTool = {
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolOut>;
};

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
      if (pair?.manifest?.tool && pair?.runner?.run) {
        reg.register(pair.manifest, pair.runner);
      }
    }
  }
  console.log(`registered runners: ${reg.list().map((m) => m.tool).sort().join(', ')}`);
}

function printToolResult(res: ToolOut): void {
  const text = (res.content ?? [])
    .map((c) => c?.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('\n');
  if (text) console.log(text);
  if (res.isError) process.exitCode = 1;
}

async function main(): Promise<void> {
  loadDevEnv();
  await registerLocalRunners();

  const [projectDir, nodeId] = process.argv.slice(2);
  if (!projectDir || !nodeId) {
    console.error('usage: tsx scripts/regenerate-local-runners.ts <projectDir> <nodeId>');
    process.exit(2);
  }

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  const res = await (dheeRegenerateNodeTool as unknown as LooseTool).execute(
    'local-regenerate',
    { projectDir, nodeId },
    ac.signal,
  );
  printToolResult(res);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
