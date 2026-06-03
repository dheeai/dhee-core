/**
 * dhee_get_status — read walkState for a project and summarize as
 * status counts + per-failed-node detail + per-in-progress elapsed
 * time. Read-only.
 *
 * Temporal awareness: the response text carries
 *   - the wall-clock time of THIS query
 *   - the wall-clock time of the LAST query for the same
 *     (projectDir, toolName) within this process
 *   - the elapsed seconds since that last query
 *   - per in-progress node: elapsed seconds since `startedAt` so
 *     the agent can reason "this has been running for 87s, close
 *     to typical completion, no point checking again"
 *
 * Rate-limit guardrail: when called with identical args within
 * RATE_LIMIT_WINDOW_MS of the prior call, the tool returns the
 * CACHED previous result (no fs read, no new query) and prepends
 * a `RATE LIMITED — you called this Ns ago` warning. The agent's
 * LLM sees this and (per SKILL.md) backs off. Defense in depth
 * against the polling-loop pattern: even if the agent ignores the
 * prompt-level "don't poll" rule, the runtime stops doing real
 * work on its behalf.
 *
 * Out of scope here: HALTING the session when the agent ignores
 * rate-limit hints. That's the chatPrompt translator's job —
 * count consecutive RATE-LIMITED responses, abort when > N.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

/**
 * Probe for whether a bundle run is ACTUALLY executing right now.
 *
 * walkState is not authoritative for liveness: a node is written
 * `in_progress` when the walker starts it, but if the run dies (process
 * killed, crash, restart) the entry is never cleared — it dangles as a
 * stale `in_progress` forever. Reading walkState alone, the agent then
 * reports "still running 26m" for a render that stopped long ago and
 * refuses to resume. The real liveness signal is the BackgroundTaskRunner:
 * if it has no active task for this project, any `in_progress` is stale.
 */
export interface ActiveRunProbe {
  /** False when the runner couldn't be consulted (headless/unknown). */
  known: boolean;
  /** projectName of the runner's active task, if any. */
  activeProjectName?: string;
}

async function defaultProbeActiveRun(): Promise<ActiveRunProbe> {
  try {
    const mod = (await import('../../../server/runners/backgroundTaskRunnerSingleton.js')) as {
      getBackgroundTaskRunner: () => { getActive: () => null | { spec?: { projectName?: string } } };
    };
    const active = mod.getBackgroundTaskRunner().getActive();
    return active
      ? { known: true, ...(active.spec?.projectName ? { activeProjectName: active.spec.projectName } : {}) }
      : { known: true };
  } catch {
    // Couldn't load the runner (e.g. headless test) — don't assert
    // liveness either way.
    return { known: false };
  }
}

export interface GetStatusDeps {
  /** Test seam — override the active-run liveness probe. */
  probeActiveRun?: () => Promise<ActiveRunProbe>;
}

const Params = Type.Object({
  projectDir: Type.String({
    description: 'Absolute path to the project directory. Required.',
  }),
});

interface NodeEntry {
  status: string;
  outputPath?: string;
  itemId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

interface ProjectJsonLite {
  walkState?: {
    nodes?: Record<string, NodeEntry>;
    lastInvalidatedIds?: string[];
  };
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
    ...(isError ? { isError: true } : {}),
  };
}

/** Rate-limit window: don't re-execute identical args within this. */
const RATE_LIMIT_WINDOW_MS = 15_000;

/** Cache cleanup window: drop entries older than this to keep map small. */
const CACHE_GC_WINDOW_MS = 5 * 60_000;

interface CacheEntry {
  argsKey: string;
  at: number;
  resultText: string;
}

const callCache = new Map<string, CacheEntry>();

function gcCache(now: number): void {
  for (const [k, v] of callCache.entries()) {
    if (now - v.at > CACHE_GC_WINDOW_MS) callCache.delete(k);
  }
}

function argsKey(params: { projectDir: string }): string {
  return `${params.projectDir}`;
}

function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function makeGetStatusTool(deps: GetStatusDeps = {}) {
  const probeActiveRun = deps.probeActiveRun ?? defaultProbeActiveRun;
  return defineTool({
    name: 'dhee_get_status',
    label: 'Project status',
    description:
      "Summarize current run progress for a project — counts of pending / in_progress / completed / failed nodes, plus error text for failed nodes and elapsed-time for in-progress nodes. Read-only. **Call AT MOST ONCE per user message.** Repeated calls within 15s are rate-limited (return cached result). The agent must not poll this tool waiting for work to finish — wait for the user to ask again.",
    parameters: Params,
    async execute(_id, params) {
      const now = Date.now();
      gcCache(now);
      const cacheKey = `${params.projectDir}::dhee_get_status`;
      const argsK = argsKey(params);
      const prior = callCache.get(cacheKey);

      // Rate-limit: same args within window → return cached.
      if (prior && prior.argsKey === argsK && now - prior.at < RATE_LIMIT_WINDOW_MS) {
        const sinceMs = now - prior.at;
        const sinceS = Math.floor(sinceMs / 1000);
        const banner =
          `RATE LIMITED — you called dhee_get_status ${sinceS}s ago with the same args. ` +
          `Returning the cached result without re-reading walkState. ` +
          `The state of a running render does not change meaningfully on a sub-15s cadence; ` +
          `don't poll this tool — let the user ask again when they want a fresh check.\n\n` +
          `(Cached at ${new Date(prior.at).toISOString()})\n\n`;
        return textResult(banner + prior.resultText);
      }

      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }
      let project: ProjectJsonLite;
      try {
        project = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
      } catch (err) {
        return textResult(`project.json failed to parse: ${(err as Error).message}`, true);
      }
      const nodes = project.walkState?.nodes ?? {};
      const buckets: Record<string, NodeEntry[]> = {
        pending: [],
        in_progress: [],
        completed: [],
        failed: [],
      };
      const keysByBucket: Record<string, string[]> = {
        pending: [],
        in_progress: [],
        completed: [],
        failed: [],
      };
      for (const [key, entry] of Object.entries(nodes)) {
        const status = entry.status;
        (buckets[status] ??= []).push(entry);
        (keysByBucket[status] ??= []).push(key);
      }

      const failedDetail: string[] = [];
      const failedKeys = keysByBucket['failed'] ?? [];
      for (const key of failedKeys) {
        const entry = nodes[key]!;
        failedDetail.push(
          `  - ${key}${entry.error ? `\n      error: ${entry.error}` : ''}${entry.outputPath ? `\n      outputPath: ${entry.outputPath}` : ''}`,
        );
      }

      // Liveness reconciliation: walkState `in_progress` is only
      // trustworthy while a run is actually executing. Consult the
      // BackgroundTaskRunner — if it isn't running THIS project, any
      // `in_progress` entry is a STALE leftover from an interrupted run
      // (killed process / crash / restart), NOT live work.
      const inProgressKeys = keysByBucket['in_progress'] ?? [];
      const probe = inProgressKeys.length > 0 ? await probeActiveRun() : { known: true as const };
      const projectName = basename(params.projectDir.replace(/\/+$/, ''));
      const runLiveForThisProject =
        probe.known && probe.activeProjectName !== undefined && probe.activeProjectName === projectName;
      // Only call an in_progress entry "stale" when we POSITIVELY know
      // no run is active here (probe.known + no matching active task).
      // If the probe couldn't run (headless), don't assert staleness.
      const inProgressIsStale = probe.known && !runLiveForThisProject && inProgressKeys.length > 0;

      const inProgressDetail: string[] = [];
      for (const key of inProgressKeys) {
        const entry = nodes[key]!;
        const startedAgo =
          entry.startedAt != null ? fmtElapsed(Math.floor((now - entry.startedAt) / 1000)) : 'unknown';
        if (inProgressIsStale) {
          inProgressDetail.push(
            `  - ${key}\n    INTERRUPTED — marked in_progress ${startedAgo} ago but NO run is active now. ` +
              `This did not finish; it was cut off (the run stopped). It will re-run on the next dispatch.`,
          );
        } else {
          inProgressDetail.push(`  - ${key}\n    running ${startedAgo}`);
        }
      }

      // Header includes wall-clock + last-query awareness so the LLM
      // sees the temporal context as part of the tool result.
      const nowIso = new Date(now).toISOString();
      const header: string[] = [`Project: ${params.projectDir}`, `Queried at: ${nowIso}`];
      if (prior) {
        const sinceS = Math.floor((now - prior.at) / 1000);
        header.push(`Previous query for this project: ${fmtElapsed(sinceS)} ago`);
      }

      const summary = [
        ...header,
        ``,
        `Status counts:`,
        `  pending:     ${(buckets['pending'] ?? []).length}`,
        `  in_progress: ${(buckets['in_progress'] ?? []).length}`,
        `  completed:   ${(buckets['completed'] ?? []).length}`,
        `  failed:      ${(buckets['failed'] ?? []).length}`,
      ];
      if (inProgressDetail.length > 0) {
        if (inProgressIsStale) {
          summary.push(
            ``,
            `Interrupted (NOT running — no active run for this project):`,
            ...inProgressDetail,
          );
          summary.push(
            ``,
            `These node(s) are stale walkState leftovers from a run that stopped, NOT live work — do NOT tell the user "it's still running". To finish them, dispatch a run (dhee_start_run / dhee_run_bundle); the walker re-runs interrupted + failed nodes and skips completed ones.`,
          );
        } else {
          summary.push(``, `In progress (run is active):`, ...inProgressDetail);
          summary.push(
            ``,
            `(If the elapsed time is well past typical, the render may have stalled — check Comfy queue. Otherwise wait for the user to ask before re-querying.)`,
          );
        }
      }
      if (failedDetail.length > 0) {
        summary.push(``, `Failed nodes:`, ...failedDetail);
      }
      const invalidated = project.walkState?.lastInvalidatedIds ?? [];
      if (invalidated.length > 0) {
        summary.push(``, `Recently invalidated (will re-run on next dispatch): ${invalidated.join(', ')}`);
      }

      const resultText = summary.join('\n');
      callCache.set(cacheKey, { argsKey: argsK, at: now, resultText });
      return textResult(resultText);
    },
  });
}

export const dheeGetStatusTool = makeGetStatusTool();

/** Test-only: clear the rate-limit cache between unit tests. */
export function __resetGetStatusCacheForTesting(): void {
  callCache.clear();
}
