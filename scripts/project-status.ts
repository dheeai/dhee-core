#!/usr/bin/env tsx
/**
 * Print a high-level status summary for a dhee-core project.
 *
 * Usage:
 *   pnpm status <project-name>
 *
 * Output:
 *   - phase status
 *   - node counts by status (completed/pending/failed/skipped)
 *   - failed nodes with their error messages
 *   - per-typeId rollup so you can see "5/7 scene_video_prompts done"
 */
import { execSync } from 'child_process';
import { loadProjectStrict, type ExecutionNode } from './cli-helpers.js';

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0] === '--help' || args[0] === '-h') {
    console.error('Usage: pnpm status <project-name>');
    process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 1);
  }

  const projectName = args[0]!;
  const { project, projectDir } = loadProjectStrict(projectName);
  const state = project.executorState;

  console.log(`Project: ${project.title}`);
  console.log(`  Path:        ${projectDir}`);
  console.log(`  Style:       ${project.style ?? '(default)'}`);
  console.log(`  Duration:    ${project.targetDuration ?? '(default 60s)'}s`);
  console.log(`  Input type:  ${project.inputType ?? '(unknown)'}`);
  console.log(`  Phase:       ${project.currentPhase ?? '(none)'}`);
  console.log('');

  // Timing — three flavors that answer different questions:
  //   1. Live process elapsed: how long the current `pnpm run-to` has been
  //      running (from ps). Tells you if the user accidentally left a stuck
  //      process running.
  //   2. Project wall-clock: now − productionStartedAt. Total real time
  //      spent on this project, including all idle gaps between runs.
  //   3. Executor time: sum(completedAt − startedAt) over all nodes that
  //      have both timestamps. Excludes idle/stuck time naturally —
  //      a stuck node has startedAt but never gets completedAt, so it
  //      contributes 0. This is the metric to use when asking "how much
  //      compute time did this project take, end to end?"
  printTiming(projectName, project);
  console.log('');

  if (project.phases) {
    console.log('Phases:');
    for (const [name, info] of Object.entries(project.phases)) {
      const marker = info.status === 'completed' ? '✓' : info.status === 'skipped' ? '⊘' : info.status === 'in_progress' ? '→' : ' ';
      console.log(`  ${marker} ${name.padEnd(28)} ${info.status}`);
    }
    console.log('');
  }

  if (!state || !state.nodes || Object.keys(state.nodes).length === 0) {
    console.log('No executor state — project hasn\'t been run yet.');
    console.log(`Try: pnpm run-to ${args[0]}`);
    return;
  }

  const all = Object.values(state.nodes) as ExecutionNode[];
  const byStatus = countBy(all, n => n.status);
  const total = all.length;

  console.log(`Nodes: ${total} total`);
  for (const [status, count] of Object.entries(byStatus)) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    console.log(`  ${status.padEnd(11)} ${count.toString().padStart(4)}  (${pct}%)`);
  }
  console.log('');

  // Per-typeId rollup
  const byType = new Map<string, { total: number; completed: number; failed: number; pending: number }>();
  for (const n of all) {
    let row = byType.get(n.typeId);
    if (!row) {
      row = { total: 0, completed: 0, failed: 0, pending: 0 };
      byType.set(n.typeId, row);
    }
    row.total++;
    if (n.status === 'completed' || n.status === 'skipped') row.completed++;
    else if (n.status === 'failed') row.failed++;
    else row.pending++;
  }

  console.log('By type:');
  const rows = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [typeId, row] of rows) {
    const status = row.failed > 0
      ? `${row.completed}/${row.total} ✓  ${row.failed} ✗  ${row.pending} ⏳`
      : `${row.completed}/${row.total} ✓  ${row.pending} ⏳`;
    console.log(`  ${typeId.padEnd(28)} ${status}`);
  }
  console.log('');

  // Failed node details
  const failed = all.filter(n => n.status === 'failed');
  if (failed.length > 0) {
    console.log(`Failed nodes (${failed.length}):`);
    for (const n of failed) {
      console.log(`  ${n.id}`);
      if (n.error) console.log(`    ${n.error.slice(0, 200)}`);
    }
    console.log('');
    console.log(`To retry: pnpm regen <project> <node-id>  (or any failed-node id above)`);
  }

  // Currently-running nodes (rare but useful)
  const running = all.filter(n => n.status === 'running');
  if (running.length > 0) {
    console.log(`Currently running:`);
    for (const n of running) console.log(`  ${n.id}`);
  }
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Find a currently-running `pnpm run-to <project>` process and its elapsed seconds.
 * Returns null when no live process is found. */
export function findLiveRunPid(projectName: string): { pid: number; elapsedSec: number } | null {
  try {
    const out = execSync('ps -eo pid,etime,command', { encoding: 'utf-8', timeout: 3000 });
    for (const line of out.split('\n')) {
      // Match either "scripts/run-to.ts <project>" exactly, or with extra args after.
      if (!line.includes('scripts/run-to.ts')) continue;
      if (!new RegExp(`run-to\\.ts ${projectName}(\\b| |$)`).test(line)) continue;
      // line: "  PID    ETIME  COMMAND..."
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+/);
      if (!m) continue;
      const pid = parseInt(m[1]!, 10);
      const elapsedSec = parsePsETime(m[2]!);
      return { pid, elapsedSec };
    }
  } catch { /* ps unavailable or timed out — return null */ }
  return null;
}

/** Parse the output of `ps -o etime` into seconds.
 *
 * Format variants (per POSIX):
 *   "MM:SS"          → e.g. "45:39" = 45m 39s
 *   "HH:MM:SS"       → e.g. "01:23:45" = 1h 23m 45s
 *   "D-HH:MM:SS"     → e.g. "2-03:04:05" = 2 days 3h 4m 5s
 */
export function parsePsETime(s: string): number {
  let days = 0;
  let rest = s;
  const dashIdx = s.indexOf('-');
  if (dashIdx > 0) {
    days = parseInt(s.slice(0, dashIdx), 10);
    rest = s.slice(dashIdx + 1);
  }
  const parts = rest.split(':').map(p => parseInt(p, 10));
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts as [number, number, number];
  else if (parts.length === 2) [m, sec] = parts as [number, number];
  else if (parts.length === 1) [sec] = parts as [number];
  return days * 86400 + h * 3600 + m * 60 + sec;
}

/** Sum (completedAt − startedAt) over all completed nodes that have both fields.
 * Stuck nodes (startedAt but no completedAt) contribute 0 → metric naturally excludes
 * idle/stuck time. */
export function executorTimeMs(nodes: ExecutionNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (typeof n.startedAt === 'number' && typeof n.completedAt === 'number') {
      total += n.completedAt - n.startedAt;
    }
  }
  return total;
}

/** Find any in-flight nodes (started but not completed). For the live UI.
 * If empty AND a live process is running, it usually means we're between
 * nodes (graph traversal, prompt building, LLM thinking). */
export function inFlightNodes(nodes: ExecutionNode[]): ExecutionNode[] {
  return nodes.filter(n =>
    typeof n.startedAt === 'number' && typeof n.completedAt !== 'number',
  );
}

/** Format a millisecond duration as "1h 23m 45s" / "12m 03s" / "45s". */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${sec.toString().padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

function printTiming(projectName: string, project: { productionStartedAt?: number; executorState?: { nodes: Record<string, ExecutionNode> } }) {
  const live = findLiveRunPid(projectName);
  const startedMs = project.productionStartedAt;
  const wallMs = startedMs ? Date.now() - startedMs : 0;
  const allNodes = Object.values(project.executorState?.nodes ?? {});
  const execMs = executorTimeMs(allNodes);
  const inFlight = inFlightNodes(allNodes);

  console.log('Timing:');
  if (live) {
    console.log(`  Live process:    PID ${live.pid}, running for ${formatDuration(live.elapsedSec * 1000)}`);
    if (inFlight.length > 0) {
      console.log(`  Currently in:    ${inFlight.map(n => n.id).join(', ')}`);
    } else {
      console.log(`  Currently in:    (between nodes — LLM call or graph traversal)`);
    }
  } else {
    console.log(`  Live process:    (no run-to currently running for this project)`);
  }
  if (startedMs) {
    console.log(`  Wall clock:      ${formatDuration(wallMs)} since project creation`);
  }
  console.log(
    `  Executor time:   ${formatDuration(execMs)}` +
    (allNodes.length === 0
      ? '   (no executor state persisted yet)'
      : `   (sum across ${allNodes.length} node(s); excludes stuck/idle)`),
  );
}

// Only run the script when invoked directly (not when imported by tests).
const isDirectExecution = process.argv[1]?.endsWith('project-status.ts')
  || process.argv[1]?.endsWith('project-status.js');
if (isDirectExecution) {
  main();
}
