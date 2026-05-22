import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/server/posthog.js', () => ({
  captureSessionEnded: vi.fn(),
  captureSessionStarted: vi.fn(),
  captureToolCallCompleted: vi.fn(),
  captureToolCallStarted: vi.fn(),
  captureWorkflowCompleted: vi.fn(),
  captureWorkflowFailed: vi.fn(),
  captureWorkflowStarted: vi.fn(),
}));

import { ConversationManager, isSilentAgentResult } from '../../src/server/ConversationManager.js';
import { ProjectStateCache, RemoteClientFileSystem, createRemoteSession, runInSession } from '../../src/core/fs/index.js';
import { writeProjectText } from '../../src/tasks/video/workflow/projectFileIO.js';

type FakeSocketHandler = (payload?: unknown) => void;

class FakeRemoteSocket {
  readyState = 1;
  sent: string[] = [];
  private handlers = new Map<string, FakeSocketHandler[]>();

  on(event: string, handler: FakeSocketHandler): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }
}

function createManager(): ConversationManager {
  return new ConversationManager({
    llmConfig: {},
    sessionTimeoutMs: 30 * 60 * 1000,
  });
}

function setAwaitingInput(manager: ConversationManager, sessionId: string): void {
  const sessions = (
    manager as unknown as {
      sessions: Map<string, { state: { status: string } }>;
    }
  ).sessions;
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Missing test session ${sessionId}`);
  }

  session.state.status = 'awaiting_input';
}

function disposeManager(manager: ConversationManager): void {
  const cleanupInterval = (
    manager as unknown as {
      cleanupInterval?: ReturnType<typeof setInterval>;
    }
  ).cleanupInterval;
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  (
    manager as unknown as {
      sessions: Map<string, unknown>;
    }
  ).sessions.clear();
}

describe('ConversationManager session activity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires awaiting_input sessions after two hours without new activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T10:00:00.000Z'));

    const manager = createManager();
    const session = manager.createSession();
    setAwaitingInput(manager, session.id);

    vi.advanceTimersByTime(2 * 60 * 60 * 1000 + 60 * 1000);

    expect(manager.hasSession(session.id)).toBe(false);

    disposeManager(manager);
  });

  it('keeps awaiting_input sessions alive when the server refreshes activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T10:00:00.000Z'));

    const manager = createManager();
    const session = manager.createSession();
    setAwaitingInput(manager, session.id);

    vi.advanceTimersByTime(90 * 60 * 1000);

    expect(manager.touchSession(session.id)).toBe(true);

    vi.advanceTimersByTime(91 * 60 * 1000);

    expect(manager.hasSession(session.id)).toBe(true);

    disposeManager(manager);
  });

  it('rebinds the active remote session context to the latest remote filesystem', () => {
    const manager = createManager();
    const socketA = new FakeRemoteSocket();
    const socketB = new FakeRemoteSocket();
    const remoteFsA = new RemoteClientFileSystem(
      socketA as never,
      new ProjectStateCache(),
    );
    const remoteFsB = new RemoteClientFileSystem(
      socketB as never,
      new ProjectStateCache(),
    );

    const session = manager.createSession('remote', remoteFsA);
    const sessions = (
      manager as unknown as {
        sessions: Map<string, { sessionContext?: ReturnType<typeof createRemoteSession> }>;
      }
    ).sessions;
    const activeSession = sessions.get(session.id);
    if (!activeSession) {
      throw new Error('Missing active session');
    }

    activeSession.sessionContext = createRemoteSession(
      session.id,
      'demo.dhee',
      remoteFsA,
    );

    manager.setRemoteFileSystem(session.id, remoteFsB);

    runInSession(activeSession.sessionContext, () => {
      writeProjectText('plans/plot.md', '# Plot\n\nSaved remotely');
    });

    expect(socketA.sent).toHaveLength(0);
    expect(socketB.sent).toHaveLength(2);
    expect(JSON.parse(socketB.sent[0] ?? '{}')).toMatchObject({
      type: 'file_mkdir_command',
      data: { path: 'plans' },
    });
    expect(JSON.parse(socketB.sent[1] ?? '{}')).toMatchObject({
      type: 'file_write_command',
      data: { path: 'plans/plot.md', content: '# Plot\n\nSaved remotely' },
    });

    disposeManager(manager);
  });

  it('forwards tool call ids and tool errors through event listeners', () => {
    const manager = createManager();
    const fakeAgent = {
      listeners: new Map<string, (data: Record<string, unknown>) => void>(),
      on(event: string, handler: (data: Record<string, unknown>) => void) {
        this.listeners.set(event, handler);
      },
    };

    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    (
      manager as unknown as {
        setupEventListeners: (
          sessionId: string,
          agent: typeof fakeAgent,
          events: {
            onToolCall: typeof onToolCall;
            onToolResult: typeof onToolResult;
          },
        ) => void;
      }
    ).setupEventListeners('session-1', fakeAgent, {
      onToolCall,
      onToolResult,
    });

    fakeAgent.listeners.get('tool_call')?.({
      toolCallId: 'tool-123',
      toolName: 'read_project',
      arguments: { path: 'project.json' },
      agentName: 'Orchestrator',
    });
    fakeAgent.listeners.get('tool_result')?.({
      toolCallId: 'tool-123',
      toolName: 'read_project',
      result: 'boom',
      isError: true,
      agentName: 'Orchestrator',
    });

    expect(onToolCall).toHaveBeenCalledWith(
      'session-1',
      'tool-123',
      'read_project',
      { path: 'project.json' },
      'Orchestrator',
    );
    expect(onToolResult).toHaveBeenCalledWith(
      'session-1',
      'tool-123',
      'read_project',
      'boom',
      true,
      'Orchestrator',
    );

    disposeManager(manager);
  });
});

/**
 * Persistent event bridge + status events.
 *
 * Problem this addresses (from the 2026-05-22 supervisor-invisible bug):
 *
 * The IPC bridge creates a fresh `eventCb` per runTask call and passes
 * it down. When the runTask returns, `session.activeEvents` is cleared.
 * A subsequent server-initiated turn (the supervisor pi-agent that
 * auto-engages on runner `completed` events) calls runTask WITHOUT an
 * eventCb — so the supervisor's tool calls and streaming text reach
 * `setupEventListeners` and die there. The renderer never knows the
 * supervisor ran.
 *
 * Fix: a session-scoped `persistentEvents` bridge, bound once by the
 * IPC layer over the stable `webContents.send` closure. runTask falls
 * back to it when no events are passed.
 *
 * Companion: every transition of `session.state.status` emits an
 * `onSessionStatus` event so the renderer can render a "supervisor
 * reviewing" pill / similar instead of being blind.
 */
describe('persistent event bridge + status emission', () => {
  it('bindSessionEventBridge stores events on the session for later runTask calls', () => {
    const manager = createManager();
    const session = manager.createSession();
    const events = { onToolCall: vi.fn() };

    (manager as unknown as {
      bindSessionEventBridge: (sid: string, e: unknown) => void;
    }).bindSessionEventBridge(session.id, events);

    const stored = (manager as unknown as {
      sessions: Map<string, { persistentEvents?: { onToolCall?: unknown } }>;
    }).sessions.get(session.id)?.persistentEvents;

    expect(stored).toBe(events);
    disposeManager(manager);
  });

  it('bindSessionEventBridge is idempotent — last binding wins (renderer reload)', () => {
    const manager = createManager();
    const session = manager.createSession();
    const eventsA = { onToolCall: vi.fn() };
    const eventsB = { onToolCall: vi.fn() };

    const bind = (manager as unknown as {
      bindSessionEventBridge: (sid: string, e: unknown) => void;
    }).bindSessionEventBridge.bind(manager);

    bind(session.id, eventsA);
    bind(session.id, eventsB);

    const stored = (manager as unknown as {
      sessions: Map<string, { persistentEvents?: unknown }>;
    }).sessions.get(session.id)?.persistentEvents;

    expect(stored).toBe(eventsB);
    disposeManager(manager);
  });

  it('unbindSessionEventBridge clears the binding (session not destroyed)', () => {
    const manager = createManager();
    const session = manager.createSession();
    const events = { onToolCall: vi.fn() };

    const m = manager as unknown as {
      bindSessionEventBridge: (sid: string, e: unknown) => void;
      unbindSessionEventBridge: (sid: string) => void;
    };
    m.bindSessionEventBridge(session.id, events);
    m.unbindSessionEventBridge(session.id);

    const stored = (manager as unknown as {
      sessions: Map<string, { persistentEvents?: unknown }>;
    }).sessions.get(session.id)?.persistentEvents;

    expect(stored).toBeUndefined();
    expect(manager.hasSession(session.id)).toBe(true);
    disposeManager(manager);
  });

  it('binding a session that does not exist is a silent no-op (no throw)', () => {
    // Avoids race: IPC bridge may call bind before the session is fully
    // created during a resume flow. Prefer silent skip over crash —
    // the next bind will land once the session exists.
    const manager = createManager();
    expect(() => {
      (manager as unknown as {
        bindSessionEventBridge: (sid: string, e: unknown) => void;
      }).bindSessionEventBridge('does-not-exist', { onToolCall: vi.fn() });
    }).not.toThrow();
    disposeManager(manager);
  });

  it('emitSessionStatus pushes onSessionStatus to bound events', () => {
    const manager = createManager();
    const session = manager.createSession();
    const onSessionStatus = vi.fn();

    (manager as unknown as {
      bindSessionEventBridge: (sid: string, e: { onSessionStatus: unknown }) => void;
    }).bindSessionEventBridge(session.id, { onSessionStatus });

    (manager as unknown as {
      setSessionStatus: (sid: string, status: string, kind?: string) => void;
    }).setSessionStatus(session.id, 'running');

    expect(onSessionStatus).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ status: 'running' }),
    );
    disposeManager(manager);
  });

  it('setSessionStatus skips emit when the status did not actually change', () => {
    // Otherwise every internal status touch produces a duplicate event
    // and the renderer's "supervisor reviewing" pill flickers.
    const manager = createManager();
    const session = manager.createSession();
    const onSessionStatus = vi.fn();

    const m = manager as unknown as {
      bindSessionEventBridge: (sid: string, e: { onSessionStatus: unknown }) => void;
      setSessionStatus: (sid: string, status: string) => void;
    };
    m.bindSessionEventBridge(session.id, { onSessionStatus });

    m.setSessionStatus(session.id, 'running');
    m.setSessionStatus(session.id, 'running'); // no-op
    m.setSessionStatus(session.id, 'completed');

    expect(onSessionStatus).toHaveBeenCalledTimes(2);
    expect(onSessionStatus.mock.calls[0]?.[1]).toMatchObject({ status: 'running' });
    expect(onSessionStatus.mock.calls[1]?.[1]).toMatchObject({ status: 'completed' });
    disposeManager(manager);
  });

  it('setSessionStatus surfaces turn kind so renderer can distinguish supervisor from user', () => {
    const manager = createManager();
    const session = manager.createSession();
    const onSessionStatus = vi.fn();

    const m = manager as unknown as {
      bindSessionEventBridge: (sid: string, e: { onSessionStatus: unknown }) => void;
      setSessionStatus: (sid: string, status: string, kind?: string) => void;
    };
    m.bindSessionEventBridge(session.id, { onSessionStatus });

    m.setSessionStatus(session.id, 'running', 'supervisor');

    expect(onSessionStatus).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ status: 'running', turnKind: 'supervisor' }),
    );
    disposeManager(manager);
  });

  it('resolveTaskEvents returns passed-in events when both are set (caller wins)', () => {
    const manager = createManager();
    const session = manager.createSession();
    const persistent = { onToolCall: vi.fn() };
    const passed = { onToolCall: vi.fn() };

    (manager as unknown as {
      bindSessionEventBridge: (sid: string, e: unknown) => void;
    }).bindSessionEventBridge(session.id, persistent);

    const resolved = (manager as unknown as {
      resolveTaskEvents: (sid: string, passed?: unknown) => unknown;
    }).resolveTaskEvents(session.id, passed);

    expect(resolved).toBe(passed);
    disposeManager(manager);
  });

  it('resolveTaskEvents falls back to persistentEvents when none passed (supervisor path)', () => {
    const manager = createManager();
    const session = manager.createSession();
    const persistent = { onToolCall: vi.fn() };

    (manager as unknown as {
      bindSessionEventBridge: (sid: string, e: unknown) => void;
    }).bindSessionEventBridge(session.id, persistent);

    const resolved = (manager as unknown as {
      resolveTaskEvents: (sid: string, passed?: unknown) => unknown;
    }).resolveTaskEvents(session.id);

    expect(resolved).toBe(persistent);
    disposeManager(manager);
  });

  it('resolveTaskEvents returns undefined when nothing bound and nothing passed', () => {
    const manager = createManager();
    const session = manager.createSession();

    const resolved = (manager as unknown as {
      resolveTaskEvents: (sid: string, passed?: unknown) => unknown;
    }).resolveTaskEvents(session.id);

    expect(resolved).toBeUndefined();
    disposeManager(manager);
  });
});

/**
 * Silent-agent detection — the loud-failure escape hatch.
 *
 * Today's bug repro: pi-agent did two reads, then went silent. The
 * LLM was aborted mid-stream (cancelTask logs confirmed) and
 * agent.run() resolved with no text. runTask returned 'completed'
 * with empty/undefined output. The chat had nothing new to render,
 * so it looked like the agent just stopped for no reason.
 *
 * Fix: classify the result, and when it's a "silent" termination
 * (interrupted OR completed-but-empty), surface a system
 * notification to the chat so the user sees that the turn ended
 * without a response. Test enumerates the failure modes the helper
 * has to recognize.
 */
describe('isSilentAgentResult — detects "no visible response" runTask outcomes', () => {
  it('treats interrupted runs as silent regardless of output', () => {
    expect(isSilentAgentResult({ status: 'interrupted' })).toBe(true);
    expect(isSilentAgentResult({ status: 'interrupted', output: '' })).toBe(true);
    // Even partial output on interrupt is suspicious — the user
    // didn't see closure. Surface a notice. (We still keep the
    // partial output in the transcript; the notice is an addition,
    // not a replacement.)
    expect(isSilentAgentResult({ status: 'interrupted', output: 'partial...' })).toBe(true);
  });

  it('treats completed runs with empty/missing output as silent', () => {
    expect(isSilentAgentResult({ status: 'completed' })).toBe(true);
    expect(isSilentAgentResult({ status: 'completed', output: '' })).toBe(true);
    expect(isSilentAgentResult({ status: 'completed', output: '   \n\t  ' })).toBe(true);
  });

  it('does NOT flag completed runs with real text', () => {
    expect(isSilentAgentResult({ status: 'completed', output: 'Done — shot 5 dialogue updated.' })).toBe(false);
    expect(isSilentAgentResult({ status: 'completed', output: 'x' })).toBe(false);
  });

  it('does NOT flag waiting_for_user — user already knows the agent is alive (question in chat)', () => {
    expect(isSilentAgentResult({ status: 'waiting_for_user' })).toBe(false);
    expect(isSilentAgentResult({ status: 'waiting_for_user', output: '' })).toBe(false);
  });

  it('does NOT flag error — runTask already throws back to the IPC bridge which surfaces "Couldn\'t reach the agent"', () => {
    // Double-surfacing would render two error rows in chat. Error
    // path has its own visible message; silent-agent is for the
    // resolved-but-empty case the error path doesn't cover.
    expect(isSilentAgentResult({ status: 'error' })).toBe(false);
    expect(isSilentAgentResult({ status: 'error', output: '' })).toBe(false);
  });
});
