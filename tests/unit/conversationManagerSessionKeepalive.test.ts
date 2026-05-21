/**
 * Regression: long-running background tasks must keep the chat
 * session alive in ConversationManager's `sessions` Map. Without
 * the keepalive, `cleanupStaleSessions` reaps the session after
 * `sessionTimeoutMs` (default 30 min) — the session is "idle" from
 * the manager's POV because runner events don't bump `lastActivity`,
 * even though they're firing constantly. Post-reap, every subsequent
 * runner event has nowhere to forward to and the chat panel freezes.
 *
 * Fix: every `runner.on(...)` handler in `subscribeToBackgroundTaskRunner`
 * uses `touchSessionActivity(sessionId)` instead of a bare
 * `sessions.get`, which bumps `state.lastActivity` as a side effect.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationManager } from '../../src/server/ConversationManager.js';
import {
  BackgroundTaskRunner,
  type TaskExecutionHooks,
} from '../../src/server/runners/BackgroundTaskRunner.js';
import { __resetBackgroundTaskRunnerForTesting } from '../../src/server/runners/backgroundTaskRunnerSingleton.js';

const SINGLETON_KEY = '__dhee_background_task_runner__';

function installRunner(runner: BackgroundTaskRunner): void {
  (globalThis as unknown as Record<string, unknown>)[SINGLETON_KEY] = runner;
}

describe('ConversationManager — runner events bump session.lastActivity (keepalive)', () => {
  let capturedHooks: TaskExecutionHooks | null = null;
  let releaseExecutor: (() => void) | null = null;

  beforeEach(() => {
    capturedHooks = null;
    releaseExecutor = null;
    __resetBackgroundTaskRunnerForTesting();
    const runner = new BackgroundTaskRunner(async (ctx) => {
      capturedHooks = ctx.hooks;
      await new Promise<void>((resolve) => {
        releaseExecutor = resolve;
      });
    });
    installRunner(runner);
  });

  afterEach(() => {
    if (releaseExecutor) releaseExecutor();
    __resetBackgroundTaskRunnerForTesting();
  });

  it('runner.onTool / onResult / onAsset bump lastActivity so cleanupStaleSessions doesn\'t reap an active pipeline', async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
    });
    const session = cm.createSession();
    const sessionId = session.id;

    // Backdate lastActivity to 25 minutes ago — close to the 30 min
    // default reap window. A single runner event MUST refresh it to
    // ~now or the cleanup reaper will kill the pipeline's session.
    const internalSessions = (
      cm as unknown as {
        sessions: Map<
          string,
          {
            state: { lastActivity: number };
            agent?: unknown;
            sessionContext?: unknown;
            initialized?: boolean;
          }
        >;
      }
    ).sessions;
    const internalSession = internalSessions.get(sessionId)!;
    const longAgo = Date.now() - 25 * 60 * 1000;
    internalSession.state.lastActivity = longAgo;
    internalSession.sessionContext = {
      sessionId,
      mode: 'local',
      projectDir: 'ambient.kshana',
    } as never;
    internalSession.initialized = true;

    // Dispatch a task so the runner captures hooks. We use the
    // singleton handle directly — no need to drive runTask, since
    // the keepalive behaviour is on the runner-event side.
    const runner = (globalThis as Record<string, unknown>)[
      SINGLETON_KEY
    ] as BackgroundTaskRunner;
    runner.dispatch({
      kind: 'run_to',
      projectName: 'test',
      sessionId,
      params: {},
    });
    // Let the 'started' event propagate.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The 'started' handler itself should already have bumped
    // lastActivity off the stale 25-min-ago value.
    expect(internalSession.state.lastActivity).toBeGreaterThan(longAgo);

    // Backdate again and fire each downstream hook. Each one must
    // refresh lastActivity.
    for (const trigger of [
      () => capturedHooks!.onTool({ toolName: 'comfy_image', nodeId: 'n1' }),
      () =>
        capturedHooks!.onResult({
          toolName: 'comfy_image',
          filePath: 'assets/images/x.png',
          status: 'completed',
        }),
      () =>
        capturedHooks!.onAsset!({
          kind: 'image',
          filePath: 'assets/images/x.png',
        }),
      () =>
        capturedHooks!.onNotification({
          level: 'info',
          message: 'progress',
        }),
    ]) {
      internalSession.state.lastActivity = longAgo;
      trigger();
      expect(internalSession.state.lastActivity).toBeGreaterThan(longAgo);
    }
  });
});
