import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getBackgroundTaskRunner } from "../../../server/runners/backgroundTaskRunnerSingleton.js";

/**
 * Dispatch a `run_to` job to the background task runner. Returns
 * IMMEDIATELY with a task id — the actual run executes off the
 * agent's tool-call loop, leaving this chat session free to take
 * follow-up questions while the work proceeds. Progress events
 * (tool / result / notification / asset) flow back through the
 * host's event channel and surface in the chat as they arrive.
 *
 * If a task is already running, the dispatch is rejected and the
 * agent gets the active task's id + kind. The agent should ask the
 * user whether to cancel + start the new one (use dhee_task_cancel
 * then dispatch again) or keep waiting.
 */

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host (e.g. dhee-desktop) created the project at a workspace path that doesn't follow the default `<name>.dhee` convention.",
    }),
  ),
  stage: Type.Optional(
    Type.String({
      description:
        "Stage to pause at, e.g. character_image, shot_image, shot_video. Or a node id like shot_image:scene_1_shot_2. Omit to run to completion.",
    }),
  ),
  skip_media: Type.Optional(
    Type.Boolean({ description: "Skip ComfyUI image/video generation; only run LLM prompt stages." }),
  ),
  /**
   * Internal: which session to tag emitted events with so they
   * route to the right chat. Pi-agent doesn't pass this directly —
   * see `createDispatchRunToTool` factory which captures it from
   * the agent's per-session context.
   */
});

export interface DispatchDetails {
  status: "started" | "rejected" | "failed";
  taskId?: string;
  reason?: string;
  activeTaskId?: string;
  activeTaskKind?: string;
  activeProjectName?: string;
  log: string;
}

/**
 * Build the tool with the calling session's id baked in, so events
 * emitted by the runner during this run get tagged correctly.
 */
export function createDispatchRunToTool(opts: {
  sessionId: string;
}): ToolDefinition {
  return defineTool({
    name: "dhee_dispatch_run_to",
    label: "dhee dispatch run-to",
    description:
      "Start a dhee_run_to job in the background. Returns immediately so this chat stays responsive — progress streams in. If a task is already running, returns a structured rejection with the active task's metadata so you can ask the user whether to cancel it.",
    parameters: Params,
    async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<DispatchDetails>> {
      try {
        const runner = getBackgroundTaskRunner();
        const result = runner.dispatch({
          kind: "run_to",
          projectName: params.project,
          sessionId: opts.sessionId,
          params: {
            ...(params.projectDir ? { projectDir: params.projectDir } : {}),
            ...(params.stage ? { stage: params.stage } : {}),
            ...(params.skip_media ? { skip_media: params.skip_media } : {}),
          },
        });

        if (result.status === "started") {
          const summary = `Started run_to task ${result.taskId} on project '${params.project}'${params.stage ? ` (stage='${params.stage}')` : ""}. Progress will stream below.`;
          return {
            content: [{ type: "text", text: summary }],
            details: { status: "started", taskId: result.taskId, log: summary },
          };
        }

        // result.status === 'rejected'
        const summary = `Cannot start: task ${result.activeTaskId} (${result.activeTaskKind}) is already running on project '${result.activeProjectName}'. Use dhee_task_cancel to abort it, or wait for it to finish.`;
        return {
          content: [{ type: "text", text: summary }],
          details: {
            status: "rejected",
            reason: result.reason,
            activeTaskId: result.activeTaskId,
            activeTaskKind: result.activeTaskKind,
            activeProjectName: result.activeProjectName,
            log: summary,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Dispatch failed: ${message}` }],
          details: { status: "failed", log: message },
        };
      }
    },
  });
}
