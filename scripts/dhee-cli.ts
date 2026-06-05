#!/usr/bin/env tsx
/**
 * dhee — a thin, generic CLI over the BUNDLE architecture.
 *
 * Why this exists: the old `pnpm <verb>` wrappers (new/status/run-to/
 * regen/...) were removed when the project migrated from the legacy
 * executor to the bundle / DAG-walker model. `src/index.ts` is now a
 * library barrel, not a CLI dispatcher, so there was no headless way
 * for an agent (Claude Code, CI, automation) to drive a render. This
 * file restores that surface.
 *
 * Design: it is DELIBERATELY thin. Every verb delegates to the exact
 * same code the desktop chat agent uses —
 *   - create  → initializeProject()          (src/dag)
 *   - run     → runProjectViaBundle()         (src/server/runners)
 *   - status/inspect/regen/override → the pi-agent tool instances
 *     (src/agent/pi/tools/*) called directly via tool.execute(...)
 * — so the CLI and the chat agent can never drift. No business logic
 * lives here; this is argument-parsing + a stop-file sentinel + I/O.
 *
 * The pi-agent tools cancel via an in-process AbortSignal only (the
 * walker checks opts.signal between nodes). A CLI `run` and a CLI
 * `stop` are SEPARATE processes, so cross-process stop needs a file
 * sentinel: `run` polls <projectDir>/.dhee.stop and aborts when it
 * appears; `stop` writes it. Ctrl-C aborts the in-flight run too.
 *
 * Project resolution: an argument is treated as an absolute/relative
 * PATH if it contains a slash; otherwise as a NAME resolved against
 * getProjectsDir() (honors $dhee_PROJECTS_DIR), then the cwd, then
 * <cwd>/<name>.dhee (legacy layout).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { loadDevEnv } from '../src/server/loadDevEnv.js';
import { getProjectsDir } from '../src/agent/pi/paths.js';
import { initializeProject } from '../src/dag/initializeProject.js';
import { runProjectViaBundle } from '../src/server/runners/runProjectViaBundle.js';
import {
  dheeGetStatusTool,
  dheeReadArtifactTool,
  dheeRegenerateNodeTool,
  dheeWriteNodeContentTool,
  dheeListBundlesTool,
} from '../src/agent/pi/tools/index.js';

/* ─── tiny arg parser ─── */

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/* ─── output helpers ─── */

function fail(msg: string): never {
  process.stderr.write(`dhee: ${msg}\n`);
  process.exit(1);
}

interface ToolOut {
  content?: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Invoke a pi defineTool instance. The pi wrapper types execute() with
 * five args (id, params, signal, onUpdate, ctx), but the dhee tools only
 * read up to `signal` at runtime — so we cast to a loose callable and
 * pass just what they use. Guaranteed parity with the chat agent's calls.
 */
type LooseTool = {
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolOut>;
};
function callTool(
  tool: unknown,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolOut> {
  return (tool as LooseTool).execute('cli', params, signal);
}

/** Print a pi-tool result envelope (text + any file_path) and set exit code. */
function printToolResult(res: ToolOut): void {
  const text = (res.content ?? [])
    .map((c) => c?.text)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('\n');
  if (text) console.log(text);
  const fp = res.details?.['file_path'];
  if (typeof fp === 'string' && fp && !text.includes(fp)) console.log(`file: ${fp}`);
  if (res.isError) process.exitCode = 1;
}

/* ─── project-dir resolution ─── */

/**
 * Where new projects live. Honors $dhee_PROJECTS_DIR (same env the rest
 * of the system reads via getProjectsDir). Falls back to ~/dhee-studios
 * rather than getProjectsDir()'s dev default (the repo root) so a `new`
 * doesn't litter the checkout with project folders.
 */
function studiosDir(): string {
  const env = process.env['dhee_PROJECTS_DIR'];
  if (env) return resolve(env.startsWith('~') ? env.replace(/^~/, homedir()) : env);
  return join(homedir(), 'dhee-studios');
}

function resolveProjectDir(arg: string | undefined, opts: { mustExist: boolean }): string {
  if (!arg) fail('a project name or path is required.');
  if (arg.includes('/') || isAbsolute(arg)) return resolve(arg);

  // Resolution order for an existing project by name: studios dir, the
  // system projects dir, cwd, then the legacy <name>.dhee layout.
  const candidates = [
    join(studiosDir(), arg),
    join(getProjectsDir(), arg),
    join(process.cwd(), arg),
    join(process.cwd(), `${arg}.dhee`),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'project.json'))) return c;
  }
  if (opts.mustExist) {
    fail(`project '${arg}' not found. Looked for project.json in:\n  ${candidates.join('\n  ')}`);
  }
  // For `new`: default to the studios dir.
  return candidates[0]!;
}

/* ─── verbs ─── */

const DEFAULT_BUNDLE = 'narrative_prompt_relay';

// Small, well-known style aliases (the bundle id space is the source of
// truth; these just smooth common phrasings).
const STYLE_ALIASES: Record<string, string> = {
  live: 'cinematic_realism',
  'live-action': 'cinematic_realism',
  realism: 'cinematic_realism',
  realistic: 'cinematic_realism',
  cinematic: 'cinematic_realism',
  animation: 'anime',
  animated: 'anime',
  cartoon: 'anime',
  '2d': 'anime',
};

function readStoryInput(flags: Record<string, string | true>): string {
  const storyFile = flagStr(flags, 'story') ?? flagStr(flags, 'input');
  if (storyFile) {
    const p = resolve(storyFile);
    if (!existsSync(p)) fail(`--story file not found: ${p}`);
    return readFileSync(p, 'utf8');
  }
  const text = flagStr(flags, 'text') ?? flagStr(flags, 'story-text');
  if (text) return text;
  if (!process.stdin.isTTY) {
    try {
      const piped = readFileSync(0, 'utf8');
      if (piped.trim()) return piped;
    } catch {
      /* no stdin */
    }
  }
  fail('a story is required. Provide --story <file>, --text "...", or pipe it on stdin.');
}

async function cmdNew(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0];
  if (!name) fail('usage: dhee new <name> --story <file> [--style ..] [--aspect ..] [--resolution ..] [--duration ..] [--bundle ..]');

  const projectDir = args.flags['dir']
    ? resolve(flagStr(args.flags, 'dir')!)
    : join(studiosDir(), name);
  if (existsSync(join(projectDir, 'project.json'))) {
    fail(`project already exists at ${projectDir}. Pick another name or delete it first.`);
  }

  const story = readStoryInput(args.flags);
  const rawStyle = flagStr(args.flags, 'style') ?? 'cinematic_realism';
  const style = STYLE_ALIASES[rawStyle.toLowerCase()] ?? rawStyle;

  const inputs: Record<string, unknown> = {
    story_input: story,
    style,
    aspect: flagStr(args.flags, 'aspect') ?? '16:9',
    resolution: Number(flagStr(args.flags, 'resolution') ?? 1080),
    targetDuration: Number(flagStr(args.flags, 'duration') ?? 60),
  };
  const styleGuide = flagStr(args.flags, 'style-guide');
  if (styleGuide) {
    const p = resolve(styleGuide);
    if (!existsSync(p)) fail(`--style-guide file not found: ${p}`);
    inputs['style_guide'] = readFileSync(p, 'utf8');
  }

  const bundleId = flagStr(args.flags, 'bundle') ?? DEFAULT_BUNDLE;

  mkdirSync(projectDir, { recursive: true });
  const r = initializeProject({ projectDir, name, bundleId, inputs });
  if (!r.ok) fail(r.error);

  console.log(`Created '${name}' (bundle: ${bundleId}) at ${projectDir}`);
  console.log(`  style=${style} aspect=${inputs['aspect']} resolution=${inputs['resolution']} duration=${inputs['targetDuration']}s`);
  console.log(`Next: pnpm dhee run ${name}        # run to the final video`);
  console.log(`  or: pnpm dhee run ${name} --to scenes_plan   # stop after a stage`);
}

function makeRunSignal(projectDir: string): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const stopFile = join(projectDir, '.dhee.stop');
  // Clear any stale sentinel from a previous run.
  if (existsSync(stopFile)) {
    try {
      rmSync(stopFile);
    } catch {
      /* ignore */
    }
  }
  const onSigint = () => {
    console.log('\n^C — aborting after the current node finishes...');
    ac.abort();
  };
  process.on('SIGINT', onSigint);
  const poll = setInterval(() => {
    if (existsSync(stopFile)) {
      console.log('stop sentinel detected — aborting after the current node...');
      try {
        rmSync(stopFile);
      } catch {
        /* ignore */
      }
      ac.abort();
    }
  }, 500);
  if (typeof poll.unref === 'function') poll.unref();
  return {
    signal: ac.signal,
    dispose: () => {
      clearInterval(poll);
      process.removeListener('SIGINT', onSigint);
    },
  };
}

async function cmdRun(args: ParsedArgs, runToStyle: boolean): Promise<void> {
  const name = args.positionals[0];
  const projectDir = resolveProjectDir(name, { mustExist: true });
  // `run-to <name> <stage>` takes the gate positionally; `run --to <stage>` via flag.
  const stopAt = flagStr(args.flags, 'to') ?? (runToStyle ? args.positionals[1] : undefined);
  const onlyRaw = flagStr(args.flags, 'only');
  const runOnly = onlyRaw
    ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const { signal, dispose } = makeRunSignal(projectDir);
  console.log(`Running '${name}'${stopAt ? ` to '${stopAt}'` : ' to final video'} — ${projectDir}`);
  try {
    const r = await runProjectViaBundle({
      projectDir,
      ...(stopAt ? { stopAt } : {}),
      ...(runOnly ? { runOnly } : {}),
      signal,
      log: (m) => console.log('  ' + m),
    });
    if (r.ok) {
      console.log(`✓ run finished${r.finalVideoAbs ? ` — final video: ${r.finalVideoAbs}` : ''}`);
    } else {
      process.exitCode = 1;
      console.error(`✗ run failed: ${r.error}`);
    }
  } finally {
    dispose();
  }
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const projectDir = resolveProjectDir(args.positionals[0], { mustExist: true });
  printToolResult(await callTool(dheeGetStatusTool, { projectDir }));
}

async function cmdInspect(args: ParsedArgs): Promise<void> {
  const projectDir = resolveProjectDir(args.positionals[0], { mustExist: true });
  const nodeId = args.positionals[1];
  if (!nodeId) fail('usage: dhee inspect <project> <nodeId> [--item <itemId>]');
  const itemId = flagStr(args.flags, 'item');
  printToolResult(
    await callTool(dheeReadArtifactTool, { projectDir, nodeId, ...(itemId ? { itemId } : {}) }),
  );
}

async function cmdRegen(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0];
  const projectDir = resolveProjectDir(name, { mustExist: true });
  const nodeId = args.positionals[1];
  if (!nodeId) fail('usage: dhee regen <project> <nodeId> [--item <itemId>]');
  const itemId = flagStr(args.flags, 'item');
  const { signal, dispose } = makeRunSignal(projectDir);
  console.log(`Regenerating '${nodeId}${itemId ? `:${itemId}` : ''}' in '${name}' (cascades downstream)...`);
  try {
    printToolResult(
      await callTool(dheeRegenerateNodeTool, { projectDir, nodeId, ...(itemId ? { itemId } : {}) }, signal),
    );
  } finally {
    dispose();
  }
}

async function cmdOverride(args: ParsedArgs): Promise<void> {
  const projectDir = resolveProjectDir(args.positionals[0], { mustExist: true });
  const nodeId = args.positionals[1];
  if (!nodeId) fail('usage: dhee override <project> <nodeId> --from <file> [--item <itemId>] [--reason ..] [--confirm]');
  const from = flagStr(args.flags, 'from');
  if (!from) fail('--from <file> is required (the new content for the node).');
  const p = resolve(from);
  if (!existsSync(p)) fail(`--from file not found: ${p}`);
  const content = readFileSync(p, 'utf8');
  const itemId = flagStr(args.flags, 'item');
  const reason = flagStr(args.flags, 'reason');
  printToolResult(
    await callTool(dheeWriteNodeContentTool, {
      projectDir,
      nodeId,
      payload: { kind: 'text', content },
      ...(itemId ? { itemId } : {}),
      ...(reason ? { reason } : {}),
      ...(args.flags['confirm'] ? { confirm: true } : {}),
    }),
  );
}

function cmdStop(args: ParsedArgs): void {
  const name = args.positionals[0];
  const projectDir = resolveProjectDir(name, { mustExist: true });
  const stopFile = join(projectDir, '.dhee.stop');
  writeFileSync(stopFile, new Date().toISOString(), 'utf8');
  console.log(`Wrote stop sentinel: ${stopFile}`);
  console.log(`A running 'pnpm dhee run ${name ?? ''}' will halt before its next node (~0.5s).`);
}

async function cmdBundles(): Promise<void> {
  printToolResult(await callTool(dheeListBundlesTool, {}));
}

interface NodeEntry {
  status?: string;
  outputPath?: string;
  error?: string;
}

function cmdNodes(args: ParsedArgs): void {
  const projectDir = resolveProjectDir(args.positionals[0], { mustExist: true });
  const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as {
    walkState?: { nodes?: Record<string, NodeEntry> };
  };
  const nodes = project.walkState?.nodes ?? {};
  const statusFilter = flagStr(args.flags, 'status');
  const grep = flagStr(args.flags, 'grep');
  const keys = Object.keys(nodes)
    .filter((k) => (statusFilter ? nodes[k]?.status === statusFilter : true))
    .filter((k) => (grep ? k.includes(grep) : true))
    .sort();
  if (keys.length === 0) {
    console.log('(no matching nodes in walkState)');
    return;
  }
  for (const k of keys) {
    const e = nodes[k]!;
    console.log(`${(e.status ?? '?').padEnd(12)} ${k}${e.error ? `\n    error: ${e.error}` : ''}`);
  }
}

const USAGE = `dhee — drive the bundle pipeline headlessly.

Usage: pnpm dhee <command> [args]

  new <name> --story <file> [--style live|anime] [--aspect 16:9|9:16]
             [--resolution 720|1080] [--duration <sec>] [--bundle <id>]
             [--style-guide <file>] [--dir <abs>]
                                  Create a project (story via --story/--text/stdin).
  status <project>                Node status counts + failures (read-only).
  nodes  <project> [--status s] [--grep r]   List walkState nodes.
  run    <project> [--to <nodeId>] [--only id,id]   Run forward (Ctrl-C / 'stop' to halt).
  run-to <project> [<nodeId>]     Same as run, gate passed positionally.
  inspect <project> <nodeId> [--item <itemId>]      Read a node's output.
  regen  <project> <nodeId> [--item <itemId>]        Invalidate + re-run (cascades).
  override <project> <nodeId> --from <file> [--item ..] [--reason ..] [--confirm]
                                  Replace a node's content with file text.
  stop   <project>                Signal a running 'run' to halt (cross-process).
  bundles                         List available bundles (pipelines).

<project> is a name (resolved under $dhee_PROJECTS_DIR / cwd / <name>.dhee)
or an explicit path. Default bundle: ${DEFAULT_BUNDLE}.`;

async function main(): Promise<void> {
  loadDevEnv(); // surface dhee-core/.env (API keys, COMFYUI_BASE_URL) for run/regen.
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (cmd) {
    case 'new':
    case 'create':
      await cmdNew(args);
      break;
    case 'status':
      await cmdStatus(args);
      break;
    case 'nodes':
    case 'ls':
      cmdNodes(args);
      break;
    case 'run':
      await cmdRun(args, false);
      break;
    case 'run-to':
      await cmdRun(args, true);
      break;
    case 'inspect':
      await cmdInspect(args);
      break;
    case 'regen':
    case 'regenerate':
      await cmdRegen(args);
      break;
    case 'override':
      await cmdOverride(args);
      break;
    case 'stop':
      cmdStop(args);
      break;
    case 'bundles':
    case 'list-bundles':
      await cmdBundles();
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      break;
    default:
      process.stderr.write(`dhee: unknown command '${cmd}'.\n\n${USAGE}\n`);
      process.exit(2);
  }
}

/**
 * Flush stdio, then force the process to exit. The bundle walker, the
 * event-log / projection engine, and analytics can leave timers/handles
 * open that keep the event loop alive after the work is done — without
 * this, `pnpm dhee run` finishes the render but never exits, leaving a
 * zombie and stranding buffered stdout (so background-task completion
 * never fires). write('', cb) resolves once the stream has drained to the
 * OS; the timer is a hard backstop if a handle blocks the drain.
 */
function flushAndExit(code: number): void {
  const backstop = setTimeout(() => process.exit(code), 3000);
  if (typeof backstop.unref === 'function') backstop.unref();
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
}

main()
  .then(() => flushAndExit(typeof process.exitCode === 'number' ? process.exitCode : 0))
  .catch((err) => {
    process.stderr.write(`dhee: fatal: ${(err as Error)?.stack ?? (err as Error)?.message ?? String(err)}\n`);
    flushAndExit(1);
  });
