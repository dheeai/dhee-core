/**
 * dhee_start_run — NON-BLOCKING bundle dispatch.
 *
 * The interactive sibling of `dhee_run_bundle`. Where `dhee_run_bundle`
 * awaits the run's terminal event (freezing the agent turn for the
 * whole multi-minute run), `dhee_start_run` dispatches and returns
 * IMMEDIATELY with the taskId. The agent's turn ends; the run executes
 * in the background; the agent stays free to receive the user's next
 * message and decide whether it warrants stopping the run.
 *
 * The desktop re-wakes the agent on the run's terminal event (see
 * dheeCoreManager terminal-event subscription), so completion /
 * failure are still surfaced — just not by blocking inside this tool.
 *
 * Use `dhee_start_run` in interactive (desktop) contexts. Use
 * `dhee_run_bundle` for headless / CLI where there's no human to
 * interject and a synchronous result is convenient.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  stopAt: Type.Optional(
    Type.String({
      description:
        "Optional node id to stop after (e.g. 'shot_image' to halt before video generation). Useful for staged review.",
    }),
  ),
  runOnly: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional list of node ids to run only (with their downstream). Equivalent to right-click-regenerate from the UI but for arbitrary nodes.',
    }),
  ),
  /**
   * The chat session id this run belongs to. The desktop threads it so
   * the terminal-event subscription can re-wake the RIGHT agent session
   * when the run finishes. Optional for headless callers.
   */
  sessionId: Type.Optional(
    Type.String({
      description:
        'Chat session id that owns this run. The host uses it to notify the originating agent when the run finishes. Omit in headless contexts.',
    }),
  ),
});

interface DispatchResultStarted {
  status: 'started';
  taskId: string;
}
interface DispatchResultRejected {
  status: 'rejected';
  reason: string;
  activeTaskId: string;
  activeProjectName: string;
}
type DispatchResult = DispatchResultStarted | DispatchResultRejected;

interface BackgroundTaskRunner {
  dispatch(spec: {
    kind: 'run_to';
    projectName: string;
    params: { projectDir: string; stage?: string; runOnly?: string[] };
    sessionId: string;
  }): DispatchResult;
}

export interface StartRunDeps {
  /** Injected for tests. Production default = the in-process runners singleton. */
  getBackgroundTaskRunner?: () => BackgroundTaskRunner | Promise<BackgroundTaskRunner>;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function defaultGetBackgroundTaskRunner(): Promise<BackgroundTaskRunner> {
  const mod = await import('../../../server/runners/backgroundTaskRunnerSingleton.js');
  return mod.getBackgroundTaskRunner() as unknown as BackgroundTaskRunner;
}

export function makeStartRunTool(deps: StartRunDeps = {}) {
  return defineTool({
    name: 'dhee_start_run',
    label: 'Start run',
    description:
      'Dispatch the bundle DAG for a project and return IMMEDIATELY (non-blocking) — the run continues in the background while you stay free to talk to the user. Prefer this over dhee_run_bundle in interactive sessions: it lets you answer questions or redirect (dhee_stop_run + fix + dhee_start_run) while the run is in flight. You will be notified when the run finishes. Pass stopAt to halt early, runOnly to re-run specific nodes (cascades downstream), sessionId so the host can route the completion back to you.',
    parameters: Params,
    async execute(_id, params): Promise<ReturnType<typeof textResult>> {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }

      const runner = deps.getBackgroundTaskRunner
        ? await deps.getBackgroundTaskRunner()
        : await defaultGetBackgroundTaskRunner();

      const dispatch = runner.dispatch({
        kind: 'run_to',
        projectName: basename(params.projectDir),
        params: {
          projectDir: params.projectDir,
          ...(params.stopAt ? { stage: params.stopAt } : {}),
          ...(params.runOnly ? { runOnly: params.runOnly } : {}),
        },
        // Carry the chat session id when provided so the host can
        // re-wake the originating agent on the terminal event. Falls
        // back to a project-tagged id for headless contexts.
        sessionId: params.sessionId ?? `dhee_start_run:${basename(params.projectDir)}`,
      });

      if (dispatch.status === 'rejected') {
        return textResult(
          `Another bundle run is already in flight (taskId=${dispatch.activeTaskId} on project '${dispatch.activeProjectName}'). Stop it first with dhee_stop_run, or wait for it to finish.`,
          true,
        );
      }

      return textResult(
        `Run started in the background (taskId=${dispatch.taskId}). It will continue while we talk; I'll be notified when it finishes. Use dhee_get_status to check progress, or dhee_stop_run to halt it.`,
      );
    },
  });
}

export const dheeStartRunTool = makeStartRunTool();
