/**
 * Regression: long-running background tasks (dhee_run_to dispatched
 * via the BackgroundTaskRunner) must keep streaming progress events
 * to the originating chat session AFTER the agent's turn ends.
 *
 * The bug: ConversationManager.runTask cleared `session.activeEvents`
 * in `finally` as soon as the agent's tool call returned. But the
 * dispatch tool returns IMMEDIATELY (the work runs in the background
 * for minutes-to-hours afterward), so by the time the runner emitted
 * `tool` / `asset` / `completed`, `activeEvents` was undefined and
 * every event was silently dropped. The chat appeared frozen.
 *
 * Fix: pin the events sink onto `session.backgroundEvents` when the
 * runner emits `started`, and route subsequent events through
 * `sinkFor(session) = backgroundEvents ?? activeEvents`. Clear
 * `backgroundEvents` on `completed` / `failed` / `cancelled`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConversationManager,
  type ConversationEvents,
} from '../../src/server/ConversationManager.js';
import {
  BackgroundTaskRunner,
  type TaskExecutionHooks,
} from '../../src/server/runners/BackgroundTaskRunner.js';
import { __resetBackgroundTaskRunnerForTesting } from '../../src/server/runners/backgroundTaskRunnerSingleton.js';

const SINGLETON_KEY = '__dhee_background_task_runner__';

function installRunner(runner: BackgroundTaskRunner): void {
  (globalThis as unknown as Record<string, unknown>)[SINGLETON_KEY] = runner;
}

describe('ConversationManager — backgroundEvents pin survives agent-turn end', () => {
  let capturedHooks: TaskExecutionHooks | null = null;
  let releaseExecutor: (() => void) | null = null;

  beforeEach(() => {
    capturedHooks = null;
    releaseExecutor = null;
    __resetBackgroundTaskRunnerForTesting();
    // Replace the global singleton with a runner whose executor we
    // control. The executor captures the hooks (so the test can fire
    // events at will) and waits on a promise so the task stays
    // "in-flight" while we tear down activeEvents.
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

  it('routes runner events to the original sink even after activeEvents is cleared', async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
    });
    const session = cm.createSession();
    const sessionId = session.id;

    const toolStreamingCalls: Array<{ chunk: string; toolName?: string }> = [];
    const toolResultCalls: Array<{ result: unknown; isError?: boolean }> = [];
    const assetCalls: Array<{ kind: string; path: string }> = [];

    const events: ConversationEvents = {
      onToolCall: () => {},
      onToolStreaming: (_sid, _id, chunk, _done, _wf, toolName) => {
        toolStreamingCalls.push({ chunk, ...(toolName ? { toolName } : {}) });
      },
      onToolResult: (_sid, _id, _name, result, isError) => {
        toolResultCalls.push({
          result,
          ...(isError !== undefined ? { isError } : {}),
        });
      },
      onMediaGenerated: (_sid, ev) => {
        assetCalls.push({ kind: ev.kind, path: ev.path });
      },
    };

    // Drive a runTask whose fake agent: (a) dispatches a background
    // task, then (b) returns. This mimics the real flow exactly:
    // dispatch tool returns immediately, agent's turn ends, runTask's
    // finally clears activeEvents.
    const fakeAgent = {
      async initialize() {},
      async run() {
        const runner = (globalThis as Record<string, unknown>)[
          SINGLETON_KEY
        ] as BackgroundTaskRunner;
        runner.dispatch({
          kind: 'run_to',
          projectName: 'test',
          sessionId,
          params: {},
        });
        // Wait one microtask so the runner's executor has captured
        // hooks and the 'started' event has propagated.
        await Promise.resolve();
        await Promise.resolve();
        return { status: 'completed' as const, output: '', todos: [] };
      },
      stop() {},
      isRunning() {
        return false;
      },
      getToolNames() {
        return [];
      },
      setAutonomousMode() {},
      on() {
        return this;
      },
      off() {
        return this;
      },
      emit() {
        return true;
      },
      removeAllListeners() {
        return this;
      },
    };
    const internalSessions = (
      cm as unknown as {
        sessions: Map<
          string,
          {
            agent?: unknown;
            sessionContext?: unknown;
            initialized?: boolean;
            activeEvents?: ConversationEvents;
            backgroundEvents?: ConversationEvents;
          }
        >;
      }
    ).sessions;
    const internalSession = internalSessions.get(sessionId)!;
    internalSession.agent = fakeAgent;
    internalSession.sessionContext = {
      sessionId,
      mode: 'local',
      projectDir: 'ambient.dhee',
    } as never;
    internalSession.initialized = true;

    await cm.runTask(sessionId, 'kick off background work', events);

    // Post-condition #1: agent's turn ended → activeEvents cleared,
    // but backgroundEvents pinned because the dispatch fired
    // 'started' while activeEvents was still set.
    expect(internalSession.activeEvents).toBeUndefined();
    expect(internalSession.backgroundEvents).toBeDefined();
    expect(capturedHooks).not.toBeNull();

    // Post-condition #2: events emitted by the still-running task
    // route through backgroundEvents, not activeEvents.
    capturedHooks!.onTool({ toolName: 'comfy_image', nodeId: 'n1' });
    capturedHooks!.onResult({
      toolName: 'comfy_image',
      filePath: 'assets/images/x.png',
      status: 'completed',
    });
    capturedHooks!.onAsset!({
      kind: 'image',
      filePath: 'assets/images/x.png',
    });

    expect(toolStreamingCalls.length).toBeGreaterThanOrEqual(2);
    expect(toolStreamingCalls.some((c) => c.toolName === 'comfy_image')).toBe(
      true,
    );
    expect(assetCalls).toEqual([
      { kind: 'image', path: 'assets/images/x.png' },
    ]);

    // Post-condition #3: completing the task fires onToolResult AND
    // clears backgroundEvents.
    releaseExecutor!();
    // give the runner's promise chain a chance to settle the
    // 'completed' emit
    await new Promise((r) => setTimeout(r, 5));

    expect(toolResultCalls.length).toBeGreaterThan(0);
    expect(internalSession.backgroundEvents).toBeUndefined();
  });
});
