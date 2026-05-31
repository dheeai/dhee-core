import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBackgroundTaskRunner } from "../../../server/runners/backgroundTaskRunnerSingleton.js";
import { resolveProjectDir } from "./resolveProjectDir.js";
import { getProjectsDir } from "../paths.js";

/**
 * Read-only snapshot of the background task runner state. The agent
 * can call this any time to answer "what's running?" without
 * triggering work.
 *
 * Anti-polling guardrail: pi-agent has been observed calling this 5-10
 * times in rapid succession during a long pipeline run, even though
 * both the tool description AND the orchestrator prompt say not to
 * poll. The streaming-progress events already keep the user informed;
 * pi-agent's repeated calls just spam the chat with no new information.
 * The cooldown below enforces the policy server-side — within the
 * window, callers get a polite "already checked recently" response that
 * tells them what's happening without consulting the runner again.
 */

const POLL_COOLDOWN_MS = 30_000;

/**
 * Last call wall-clock time. Module-level singleton — there's only
 * one background-runner-driven task in flight per process, so a
 * single shared counter is sufficient. Exported as a reset helper
 * for tests.
 */
let lastCallAt = 0;

export function __resetTaskStatusCooldownForTesting(): void {
  lastCallAt = 0;
}

export interface TaskStatusDetails {
  active: boolean;
  taskId?: string;
  kind?: string;
  projectName?: string;
  projectDir?: string;
  startedAt?: number;
  log: string;
  /** True when this response was served from the cooldown gate rather
   *  than a fresh runner read. The agent's prompt can use this signal
   *  to back off if it sees it. */
  throttled?: boolean;
  /**
   * Bug 15: pipeline lifecycle distinguishes "actively rendering" from
   * "stuck blocked" from "no task at all":
   *   - 'running' — runner active AND ≥1 node in_progress (real work)
   *   - 'blocked' — runner active OR ≥1 failed node, AND zero in_progress
   *     (pipeline can't make progress until invalidate-and-retry)
   *   - 'idle'    — no active task and no failed nodes
   * Pi-agent's "wait for it" guidance should only fire on 'running'. On
   * 'blocked', the agent should call dhee_invalidate + dhee_dispatch_run_to
   * to clear the failure and resume. The cooldown response is purely
   * about polling protection; the lifecycle is the real signal.
   */
  lifecycle?: 'running' | 'blocked' | 'idle';
  /** Node counts surfaced for telemetry / agent reasoning. */
  inProgressCount?: number;
  failedCount?: number;
}

interface ExecutorStateSnapshot {
  nodes?: Record<string, { status?: string } | undefined>;
}

function readLifecycleFromProject(projectName: string | undefined, projectDirOverride?: string): {
  lifecycle: 'running' | 'blocked' | 'idle';
  inProgress: number;
  failed: number;
} {
  // Default when we can't resolve the project — assume idle (no project,
  // no work). Defensive: caller-side errors should NOT take down the
  // task-status read, which is the very tool the agent uses to recover.
  const fallback = { lifecycle: 'idle' as const, inProgress: 0, failed: 0 };
  if (!projectName) return fallback;
  try {
    const projectDir = resolveProjectDir({
      name: projectName,
      basePath: getProjectsDir(),
      ...(projectDirOverride ? { projectDir: projectDirOverride } : {}),
    });
    const projectJsonPath = join(projectDir, 'project.json');
    if (!existsSync(projectJsonPath)) return fallback;
    const raw = readFileSync(projectJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { executorState?: ExecutorStateSnapshot };
    const nodes = parsed?.executorState?.nodes ?? {};
    let inProgress = 0;
    let failed = 0;
    for (const n of Object.values(nodes)) {
      if (!n) continue;
      if (n.status === 'in_progress' || n.status === 'running') inProgress += 1;
      else if (n.status === 'failed') failed += 1;
    }
    let lifecycle: 'running' | 'blocked' | 'idle';
    if (inProgress > 0) lifecycle = 'running';
    else if (failed > 0) lifecycle = 'blocked';
    else lifecycle = 'idle';
    return { lifecycle, inProgress, failed };
  } catch {
    return fallback;
  }
}

export const dheeTaskStatus = defineTool({
  name: "dhee_task_status",
  label: "dhee task status",
  description:
    "Report what background task (if any) is currently running. **DO NOT call this in a loop while a run is in progress** — the runner streams progress events into the chat in real time, the user already sees them, and repeated polls only add noise. Use this when the user asks 'what's running?', when you finished an action and want to confirm a state transition, or after at least 60 seconds of silence — never on a tighter cadence. Calls within 30 seconds of the previous call are throttled (the runner returns the prior snapshot without re-querying).",
  parameters: Type.Object({}),
  async execute(): Promise<AgentToolResult<TaskStatusDetails>> {
    const now = Date.now();
    const sinceLast = now - lastCallAt;
    const runner = getBackgroundTaskRunner();
    const active = runner.getActive();
    const activeProjectDir =
      typeof active?.spec.params['projectDir'] === 'string'
        ? active.spec.params['projectDir']
        : undefined;

    // Throttle path: within cooldown, return the bare-minimum
    // information plus a strong directive telling pi-agent to stop
    // polling and wait for streaming events. We DON'T return stale
    // data here — just the active/inactive bit + the cooldown msg —
    // so pi-agent can't use repeated polls to "watch progress" by
    // diffing snapshots.
    if (lastCallAt > 0 && sinceLast < POLL_COOLDOWN_MS) {
      const remainingSec = Math.ceil((POLL_COOLDOWN_MS - sinceLast) / 1000);
      const summary = active
        ? `Task is running. You polled ${Math.round(sinceLast / 1000)}s ago — STOP CHECKING. The runner streams progress events automatically; the user sees them in real time. Wait at least ${remainingSec}s before another status check, or just wait for the supervisor to re-engage you.`
        : `No background task is running. You just checked ${Math.round(sinceLast / 1000)}s ago. STOP polling — answer the user directly.`;
      return {
        content: [{ type: "text", text: summary }],
        details: {
          active: !!active,
          ...(activeProjectDir ? { projectDir: activeProjectDir } : {}),
          log: summary,
          throttled: true,
        },
      };
    }

    lastCallAt = now;

    if (!active) {
      // Even with no runner-active task, the project's executorState may
      // still show failed nodes from a prior aborted run — surface that
      // as 'blocked' so the agent can recover instead of replying "idle".
      const summary = "No background task is running.";
      return {
        content: [{ type: "text", text: summary }],
        details: {
          active: false,
          log: summary,
          lifecycle: 'idle',
          inProgressCount: 0,
          failedCount: 0,
        },
      };
    }
    const elapsedSec = Math.round((now - active.startedAt) / 1000);
    const { lifecycle, inProgress, failed } = readLifecycleFromProject(
      active.spec.projectName,
      activeProjectDir,
    );

    // Bug 15: distinguish 'running' from 'blocked' in the agent-facing
    // text. A task that's "active" from the runner's perspective but
    // 0-in_progress / ≥1-failed is stuck on a failure and needs the
    // agent to invalidate the failed node, not wait for streaming events
    // that will never arrive.
    let summary: string;
    if (lifecycle === 'blocked') {
      summary =
        `BLOCKED: ${active.spec.kind} on '${active.spec.projectName}' has ${failed} failed node(s) and 0 in flight. ` +
        `The runner is NOT making progress — do NOT wait for streaming events. ` +
        `Call dhee_invalidate on the failed node(s), then dhee_dispatch_run_to to resume.`;
    } else if (lifecycle === 'running') {
      summary =
        `Running: ${active.spec.kind} on '${active.spec.projectName}' (task ${active.id}, ${elapsedSec}s elapsed, ${inProgress} node(s) in flight). ` +
        `DO NOT call this tool again until you're explicitly asked or 60+ seconds have passed — the runner streams progress events automatically.`;
    } else {
      // active task but 0 in_progress and 0 failed — between dispatches /
      // about to start. Treat like idle/pending for messaging.
      summary =
        `Task ${active.spec.kind} on '${active.spec.projectName}' is registered but no nodes are in flight yet (task ${active.id}). ` +
        `Pipeline is between dispatches.`;
    }

    return {
      content: [{ type: "text", text: summary }],
      details: {
        active: true,
        taskId: active.id,
        kind: active.spec.kind,
        projectName: active.spec.projectName,
        ...(activeProjectDir ? { projectDir: activeProjectDir } : {}),
        startedAt: active.startedAt,
        log: summary,
        lifecycle,
        inProgressCount: inProgress,
        failedCount: failed,
      },
    };
  },
});
