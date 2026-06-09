/**
 * dhee_run_bundle — dispatch a bundle DAG run via the
 * BackgroundTaskRunner.
 *
 * Phase 6.5c.c: previously this called runProjectViaBundle directly,
 * which blocked the tool call until the bundle finished AND produced
 * no per-node progress events (so the desktop's status strip stayed
 * silent during a 30-min run). Now we dispatch through
 * BackgroundTaskRunner.dispatch — the same runner the desktop's
 * status strip subscribes to — and await its terminal event.
 *
 * The tool call still appears to block from pi-agent's perspective
 * (the LLM sees one tool call that takes minutes to resolve), but
 * the runner's event stream surfaces progress to whatever's listening
 * (the chat panel's stream_chunk handler, the status strip, etc).
 * That gives the user something to watch while the model "thinks."
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { buildGateRunResult } from './gateRunResult.js';

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

interface RunnerRecord {
  task: {
    id: string;
    /**
     * Set when the run `completed` only because the
     * stop-after-each-collection gate paused it. Lets the completed
     * handler report the real (gated) reason instead of a generic
     * "completed". See issue #133.
     */
    gatedAfter?: string;
    /** Downstream node ids still pending behind the gate (with `gatedAfter`). */
    pendingAfterGate?: string[];
  };
}
interface TaskFailedEvent extends RunnerRecord {
  error: string;
}

interface BackgroundTaskRunner {
  dispatch(spec: {
    kind: 'run_to';
    projectName: string;
    params: { projectDir: string; stage?: string; runOnly?: string[] };
    sessionId: string;
  }): DispatchResult;
  on<E extends 'completed' | 'failed' | 'cancelled'>(
    event: E,
    handler: (
      payload: E extends 'failed' ? TaskFailedEvent : RunnerRecord,
    ) => void,
  ): () => void;
}

export interface RunBundleDeps {
  /**
   * Injected for tests. Production default = the in-process runners
   * module singleton.
   */
  getBackgroundTaskRunner?: () => BackgroundTaskRunner;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function defaultGetBackgroundTaskRunner(): Promise<BackgroundTaskRunner> {
  const mod = await import('../../../server/runners/backgroundTaskRunnerSingleton.js');
  return mod.getBackgroundTaskRunner() as unknown as BackgroundTaskRunner;
}

export function makeRunBundleTool(deps: RunBundleDeps = {}) {
  return defineTool({
    name: 'dhee_run_bundle',
    label: 'Run bundle',
    description:
      'Dispatch the bundle DAG for a project via the in-process BackgroundTaskRunner. Returns when the run finishes (success / failure / cancelled). The runner emits per-node progress to the UI status strip while this tool call is in flight. Pass stopAt to halt at an earlier stage, or runOnly to re-run specific nodes (cascades to their downstream). NOTE: a run can also pause on the "Stop after each collection" gate (gateAfterCollections) — when it does, the result says so and lists the stages still pending; that is an intentional pause, not a failure or a missing endpoint, so resume to continue rather than diagnosing the missing downstream output.',
    parameters: Params,
    async execute(_id, params): Promise<ReturnType<typeof textResult>> {
      const projectJsonPath = join(params.projectDir, 'project.json');
      if (!existsSync(projectJsonPath)) {
        return textResult(`project.json not found at ${projectJsonPath}`, true);
      }

      const runner = deps.getBackgroundTaskRunner
        ? deps.getBackgroundTaskRunner()
        : await defaultGetBackgroundTaskRunner();

      const dispatch = runner.dispatch({
        kind: 'run_to',
        projectName: basename(params.projectDir),
        params: {
          projectDir: params.projectDir,
          ...(params.stopAt ? { stage: params.stopAt } : {}),
          ...(params.runOnly ? { runOnly: params.runOnly } : {}),
        },
        // Tagged with the project basename so the runner's events
        // route to whoever is listening. The exact sessionId here is
        // informational — events are global.
        sessionId: `dhee_run_bundle:${basename(params.projectDir)}`,
      });

      if (dispatch.status === 'rejected') {
        return textResult(
          `Another bundle run is already in flight (taskId=${dispatch.activeTaskId} on project '${dispatch.activeProjectName}'). Stop that one first or wait for it to finish.`,
          true,
        );
      }

      const taskId = dispatch.taskId;
      const matches = (e: RunnerRecord): boolean => e.task.id === taskId;

      // Await the terminal event — the tool stays "in-flight" from
      // pi-agent's perspective for the whole run, but the runner's
      // events flow to the UI status strip via dheeCoreManager's
      // event bus. Cleaner than blocking on a Promise inside
      // runProjectViaBundle.
      return new Promise((resolve) => {
        const offs: Array<() => void> = [];
        const cleanup = () => offs.forEach((off) => off());

        offs.push(
          runner.on('completed', (e) => {
            if (!matches(e)) return;
            cleanup();
            // A run can "complete" because it paused on the
            // stop-after-each-collection gate, not because it ran
            // end-to-end. When the runner stamped `gatedAfter` onto the
            // event, report the gate reason explicitly so the agent
            // narrates "paused, resume to continue" instead of guessing
            // why downstream produced nothing (issue #133).
            if (e.task.gatedAfter) {
              resolve(
                textResult(
                  buildGateRunResult({
                    gatedAfter: e.task.gatedAfter,
                    ...(e.task.pendingAfterGate
                      ? { pendingAfterGate: e.task.pendingAfterGate }
                      : {}),
                  }),
                ),
              );
              return;
            }
            resolve(textResult(`Bundle run completed (taskId=${taskId}).`));
          }),
        );
        offs.push(
          runner.on('failed', (e) => {
            if (!matches(e)) return;
            cleanup();
            resolve(
              textResult(
                `Bundle run failed: ${(e as TaskFailedEvent).error ?? '(no error)'}`,
                true,
              ),
            );
          }),
        );
        offs.push(
          runner.on('cancelled', (e) => {
            if (!matches(e)) return;
            cleanup();
            resolve(textResult(`Bundle run cancelled (taskId=${taskId}).`, true));
          }),
        );
      });
    },
  });
}

export const dheeRunBundleTool = makeRunBundleTool();
