import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getBackgroundTaskRunner } from "../../../server/runners/backgroundTaskRunnerSingleton.js";

/**
 * Abort the currently-running background task. Idempotent — calling
 * when nothing is running returns a benign result. Use this BEFORE
 * dispatching a new task that conflicts with the active one (or use
 * the `replace` shorthand on the runner from the host).
 */

const Params = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        "Specific task id to cancel. Omit to cancel whatever is running. Including the id is safer in concurrent flows because it'll no-op if a different task is now active.",
    }),
  ),
});

export interface CancelDetails {
  cancelled: boolean;
  log: string;
}

export const dheeTaskCancel = defineTool({
  name: "dhee_task_cancel",
  label: "dhee task cancel",
  description:
    "Cancel the active background task. Returns immediately — the abort signal still takes a moment to propagate through the executor and any in-flight ComfyUI / LLM calls. Subscribers to the runner's events will see a 'cancelled' notification when the task actually winds down.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<CancelDetails>> {
    const runner = getBackgroundTaskRunner();
    const ok = runner.cancel(params.taskId);
    const summary = ok
      ? "Cancel signal sent. The task will wind down on its next tick."
      : "Nothing to cancel.";
    return {
      content: [{ type: "text", text: summary }],
      details: { cancelled: ok, log: summary },
    };
  },
});
