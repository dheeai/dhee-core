/**
 * dhee_stop_run — abort the in-flight bundle run.
 *
 * The abort capability the agent previously lacked (abort lived only
 * in the desktop's Stop button). The agent calls this when the user's
 * message warrants halting the run — e.g. "shot 3 is warped, redo it."
 *
 * Critically, it AWAITS the runner's `cancelled` terminal event before
 * returning (bounded by a timeout). The BackgroundTaskRunner is
 * single-flight: it rejects a new dispatch while a task is active, and
 * the active slot frees only after the executor notices the abort
 * signal. So a naive `cancel()` followed immediately by
 * `dhee_start_run` would hit `rejected`. By waiting for `cancelled`,
 * the subsequent start is safe.
 */

import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

interface RunnerRecord {
  task: { id: string };
}
interface BackgroundTaskRunner {
  /** Returns false when nothing is running. */
  cancel(taskId?: string): boolean;
  on<E extends 'completed' | 'failed' | 'cancelled'>(
    event: E,
    handler: (payload: RunnerRecord) => void,
  ): () => void;
  /** True iff a task is currently active. */
  hasActive?(): boolean;
}

export interface StopRunDeps {
  getBackgroundTaskRunner?: () => BackgroundTaskRunner | Promise<BackgroundTaskRunner>;
  /** Override the cancel-confirmation timeout (ms). Default 15000. */
  cancelTimeoutMs?: number;
  /** Test seam for the timeout timer. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

async function defaultGetBackgroundTaskRunner(): Promise<BackgroundTaskRunner> {
  const mod = await import('../../../server/runners/backgroundTaskRunnerSingleton.js');
  return mod.getBackgroundTaskRunner() as unknown as BackgroundTaskRunner;
}

const Params = Type.Object({
  projectDir: Type.Optional(
    Type.String({
      description:
        'Optional project dir, for logging/context. The runner is single-flight so the active run is unambiguous; this is informational.',
    }),
  ),
});

export function makeStopRunTool(deps: StopRunDeps = {}) {
  const timeoutMs = deps.cancelTimeoutMs ?? 15000;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return defineTool({
    name: 'dhee_stop_run',
    label: 'Stop run',
    description:
      'Abort the in-flight bundle run and WAIT until it has actually stopped (so a follow-up dhee_start_run is safe). Use when the user wants to redirect a running pipeline — e.g. they point out a bad shot. After stopping, fix the upstream node (dhee_critique_node / dhee_write_node_content) then dhee_start_run to resume; the walker skips already-completed shots. Returns immediately with stopped:false if nothing was running.',
    parameters: Params,
    async execute(): Promise<ReturnType<typeof textResult>> {
      const runner = deps.getBackgroundTaskRunner
        ? await deps.getBackgroundTaskRunner()
        : await defaultGetBackgroundTaskRunner();

      // Subscribe to the terminal event BEFORE issuing the cancel so we
      // can't miss a fast cancellation.
      const settled = new Promise<'cancelled' | 'completed' | 'failed'>((resolve) => {
        const offs: Array<() => void> = [];
        const done = (kind: 'cancelled' | 'completed' | 'failed') => {
          offs.forEach((off) => off());
          resolve(kind);
        };
        offs.push(runner.on('cancelled', () => done('cancelled')));
        // A run can race to completion/failure between our cancel and the
        // abort landing — treat those as "no longer running" too.
        offs.push(runner.on('completed', () => done('completed')));
        offs.push(runner.on('failed', () => done('failed')));
      });

      const wasRunning = runner.cancel();
      if (!wasRunning) {
        return textResult('No bundle run is currently active — nothing to stop.');
      }

      const timedOut = Symbol('timeout');
      let handle: unknown;
      const timeout = new Promise<typeof timedOut>((resolve) => {
        handle = setT(() => resolve(timedOut), timeoutMs);
      });

      const outcome = await Promise.race([settled, timeout]);
      clearT(handle);

      if (outcome === timedOut) {
        return textResult(
          'Stop requested, but the run did not confirm cancellation within the timeout. It is aborting; check dhee_get_status before starting a new run.',
        );
      }
      if (outcome === 'cancelled') {
        return textResult('Run stopped. You can now fix the relevant node and dhee_start_run to resume.');
      }
      // Raced to a natural terminal state.
      return textResult(
        `The run reached '${outcome}' before the stop landed — nothing left to abort. Check dhee_get_status.`,
      );
    },
  });
}

export const dheeStopRunTool = makeStopRunTool();
