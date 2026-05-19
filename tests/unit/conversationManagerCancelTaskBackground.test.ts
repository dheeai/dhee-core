/**
 * Bug 2026-05-04: clicking the desktop's Stop button left the
 * BackgroundTaskRunner running. The chat showed "Stopping..." while
 * the executor kept ploughing through every shot in the project.
 *
 * Root cause: `ConversationManager.cancelTask(sessionId)` only stopped
 * the pi-agent's own loop (`session.agent.stop()`) — but kshana_run_to
 * is dispatched OUT of the chat's call stack into the
 * BackgroundTaskRunner. The runner has its own AbortController.
 * Stopping the agent left the runner alone, so the actual heavy work
 * was unaffected by the cancel.
 *
 * Fix: `cancelTask` must also cancel the active background task when
 * its `spec.sessionId` matches the cancelled session. Other sessions'
 * tasks must NOT be touched (different chat windows are independent).
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

const SINGLETON_KEY = '__kshana_background_task_runner__';

function installRunner(runner: BackgroundTaskRunner): void {
  (globalThis as unknown as Record<string, unknown>)[SINGLETON_KEY] = runner;
}

interface InternalSession {
  agent?: unknown;
  sessionContext?: unknown;
  initialized?: boolean;
  activeEvents?: ConversationEvents;
  backgroundEvents?: ConversationEvents;
}

function fakeAgentThatDispatches(
  runner: BackgroundTaskRunner,
  sessionId: string,
): {
  // Just enough surface that ConversationManager.runTask is happy.
  initialize: () => Promise<void>;
  run: () => Promise<{ status: 'completed'; output: string; todos: never[] }>;
  stop: () => void;
  stopCalled: () => boolean;
  isRunning: () => boolean;
  getToolNames: () => string[];
  setAutonomousMode: () => void;
  on: () => unknown;
  off: () => unknown;
  emit: () => boolean;
  removeAllListeners: () => unknown;
} {
  let stopWasCalled = false;
  return {
    async initialize() {},
    async run() {
      runner.dispatch({
        kind: 'run_to',
        projectName: 'test',
        sessionId,
        params: {},
      });
      // Let the runner kick off its executor before the agent's turn ends.
      await Promise.resolve();
      await Promise.resolve();
      return { status: 'completed' as const, output: '', todos: [] };
    },
    stop() {
      stopWasCalled = true;
    },
    stopCalled: () => stopWasCalled,
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
}

describe('ConversationManager.cancelTask — cancels dispatched background tasks', () => {
  let signalReceived: AbortSignal | null = null;
  let executorResolved = false;
  let runner: BackgroundTaskRunner;

  beforeEach(() => {
    signalReceived = null;
    executorResolved = false;
    __resetBackgroundTaskRunnerForTesting();
    runner = new BackgroundTaskRunner(async (ctx) => {
      signalReceived = ctx.signal;
      // Stay "running" until the signal aborts.
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          executorResolved = true;
          resolve();
        });
      });
    });
    installRunner(runner);
  });

  afterEach(() => {
    __resetBackgroundTaskRunnerForTesting();
  });

  function buildSession(cm: ConversationManager, sessionId: string, agent: unknown): InternalSession {
    const internalSessions = (
      cm as unknown as { sessions: Map<string, InternalSession> }
    ).sessions;
    const internalSession = internalSessions.get(sessionId)!;
    internalSession.agent = agent;
    internalSession.sessionContext = {
      sessionId,
      mode: 'local',
      projectDir: 'ambient.kshana',
    } as never;
    internalSession.initialized = true;
    return internalSession;
  }

  it('aborts the active background task whose sessionId matches the cancelled session', async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
    });
    const session = cm.createSession();
    const sessionId = session.id;
    const agent = fakeAgentThatDispatches(runner, sessionId);
    buildSession(cm, sessionId, agent);

    const sinkEvents: ConversationEvents = {
      onToolCall: () => {},
      onToolStreaming: () => {},
      onToolResult: () => {},
    };

    // Run a turn that dispatches a long-running background task.
    await cm.runTask(sessionId, 'kick off long work', sinkEvents);

    // Sanity: a task is now active in the runner.
    expect(runner.isBusy()).toBe(true);
    expect(signalReceived).not.toBeNull();
    expect(signalReceived!.aborted).toBe(false);

    // The Stop button calls cancelTask(sessionId).
    const cancelled = cm.cancelTask(sessionId);

    expect(cancelled).toBe(true);
    expect(agent.stopCalled()).toBe(true); // pi-agent loop was stopped
    expect(signalReceived!.aborted).toBe(true); // background runner was ALSO aborted

    // Settle the runner's promise chain.
    await new Promise((r) => setTimeout(r, 5));
    expect(executorResolved).toBe(true);
    expect(runner.isBusy()).toBe(false);
  });

  // 2026-05-19: this test previously pinned multi-session ISOLATION — a
  // cancel on session B must NOT abort a runner task dispatched by
  // session A. That contract was based on a hypothetical multi-session
  // model that never actually shipped. In production today only ONE
  // session is active at a time; the desktop creates a fresh session
  // (via clearChatHistory) every time the chat resets, which means the
  // runner's active.spec.sessionId can legitimately drift away from
  // the renderer's current sessionId during a single user's run. The
  // old sessionId-match gate then silently dropped EVERY cancel after
  // such a drift, producing the stuck-Stopping incident traced on
  // 2026-05-19. The replacement test below pins the new contract:
  // cancel from ANY session reaches the runner's active task. If we
  // ever ship true multi-session concurrency, write a different test
  // — and DON'T re-introduce the silent gate.
  it('cancels the active background task regardless of which sessionId triggered the cancel (single-session model)', async () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
    });
    const sessionA = cm.createSession();
    const sessionB = cm.createSession();
    const agentA = fakeAgentThatDispatches(runner, sessionA.id);
    const agentB = fakeAgentThatDispatches(runner, sessionB.id);
    buildSession(cm, sessionA.id, agentA);
    buildSession(cm, sessionB.id, agentB);

    const sinkEvents: ConversationEvents = {
      onToolCall: () => {},
      onToolStreaming: () => {},
      onToolResult: () => {},
    };

    // Session A's turn dispatches the background task. Then session B
    // takes over the chat (simulates the renderer renaming its session
    // via clearChatHistory — the runner task is still under A's id).
    await cm.runTask(sessionA.id, 'A kicks off work', sinkEvents);
    expect(runner.isBusy()).toBe(true);
    const sigBeforeCancel = signalReceived;
    expect(sigBeforeCancel!.aborted).toBe(false);

    // User clicks Stop while the renderer's session is B. The runner's
    // active task was started under A — but it's THIS user's work, so
    // the cancel MUST reach it.
    const cancelledB = cm.cancelTask(sessionB.id);

    expect(cancelledB).toBe(true);
    expect(agentB.stopCalled()).toBe(true);
    // The runner cancel is unconditional now; A's signal aborts.
    expect(sigBeforeCancel!.aborted).toBe(true);
    // Microtask flush so the executor's `signal.addEventListener('abort', resolve)`
    // listener gets to run and clear `runner.active`. Otherwise the
    // assertion fires before the cancel cascade settles.
    await new Promise<void>((r) => setImmediate(r));
    expect(runner.isBusy()).toBe(false);
  });

  it('returns false and is a no-op when no session and no background task exist', () => {
    const cm = new ConversationManager({
      llmConfig: { baseUrl: 'x', apiKey: 'x', model: 'x' } as never,
    });
    expect(cm.cancelTask('does-not-exist')).toBe(false);
    expect(runner.isBusy()).toBe(false);
  });
});
