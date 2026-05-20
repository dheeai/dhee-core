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

import { ConversationManager } from '../../src/server/ConversationManager.js';
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
