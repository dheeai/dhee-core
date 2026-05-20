import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getBackgroundTaskRunner } from "../../../server/runners/backgroundTaskRunnerSingleton.js";

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
  startedAt?: number;
  log: string;
  /** True when this response was served from the cooldown gate rather
   *  than a fresh runner read. The agent's prompt can use this signal
   *  to back off if it sees it. */
  throttled?: boolean;
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
          log: summary,
          throttled: true,
        },
      };
    }

    lastCallAt = now;

    if (!active) {
      const summary = "No background task is running.";
      return {
        content: [{ type: "text", text: summary }],
        details: { active: false, log: summary },
      };
    }
    const elapsedSec = Math.round((now - active.startedAt) / 1000);
    const summary = `Running: ${active.spec.kind} on '${active.spec.projectName}' (task ${active.id}, ${elapsedSec}s elapsed). DO NOT call this tool again until you're explicitly asked or 60+ seconds have passed — the runner streams progress events automatically.`;
    return {
      content: [{ type: "text", text: summary }],
      details: {
        active: true,
        taskId: active.id,
        kind: active.spec.kind,
        projectName: active.spec.projectName,
        startedAt: active.startedAt,
        log: summary,
      },
    };
  },
});
