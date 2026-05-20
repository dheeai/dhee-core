import { describe, expect, it, vi } from 'vitest';

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
import { WebSocketHandler } from '../../src/server/WebSocketHandler.js';
import { desktopAssemblyBroker } from '../../src/core/remote/DesktopAssemblyBroker.js';

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  private handlers = new Map<string, Array<(...payload: unknown[]) => void>>();

  send(payload: string): void {
    this.sent.push(payload);
  }

  on(event: string, handler: (...payload: unknown[]) => void): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(event: string, ...payload: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...payload);
    }
  }
}

describe('WebSocketHandler tool event forwarding', () => {
  it('sends tool_call messages with the real toolCallId and error status', () => {
    const manager = new ConversationManager({
      llmConfig: {},
    });
    const handler = new WebSocketHandler(manager);
    const socket = new FakeSocket();

    const events = (
      handler as unknown as {
        createEventHandlers: (
          sessionId: string,
          socket: FakeSocket,
        ) => {
          onToolCall: (
            sid: string,
            toolCallId: string,
            toolName: string,
            args: Record<string, unknown>,
            agentName?: string,
          ) => void;
          onToolResult: (
            sid: string,
            toolCallId: string,
            toolName: string,
            result: unknown,
            isError?: boolean,
            agentName?: string,
          ) => void;
        };
      }
    ).createEventHandlers('session-1', socket);

    events.onToolCall(
      'session-1',
      'tool-1',
      'generate_content',
      { content_type: 'plot' },
      'Orchestrator',
    );
    events.onToolResult(
      'session-1',
      'tool-1',
      'generate_content',
      'failure',
      true,
      'Orchestrator',
    );

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'tool_call',
      sessionId: 'session-1',
      data: {
        toolCallId: 'tool-1',
        toolName: 'generate_content',
        status: 'started',
      },
    });
    expect(JSON.parse(socket.sent[1] ?? '{}')).toMatchObject({
      type: 'tool_call',
      sessionId: 'session-1',
      data: {
        toolCallId: 'tool-1',
        toolName: 'generate_content',
        status: 'error',
        error: 'failure',
      },
    });

    (manager as unknown as { shutdown: () => void }).shutdown();
  });

  it('stores remote desktop capabilities and routes timeline assembly requests over the websocket', async () => {
    const manager = new ConversationManager({ llmConfig: {} });
    const handler = new WebSocketHandler(manager, { serverMode: 'remote' });
    const socket = new FakeSocket();

    handler.handleConnection(
      socket as never,
      '203.0.113.5',
      undefined,
      undefined,
      {
        desktopAssembly: true,
        desktopRemotion: true,
        desktopVersion: '1.2.3',
      },
    );

    const statusMessage = JSON.parse(socket.sent[0] ?? '{}');
    const sessionId = statusMessage.sessionId as string;

    expect(manager.getSessionMode(sessionId)).toBe('remote');
    expect(manager.getDesktopCapabilities(sessionId)).toEqual({
      desktopAssembly: true,
      desktopRemotion: true,
      desktopVersion: '1.2.3',
    });
    expect(desktopAssemblyBroker.canAssemble(sessionId)).toBe(true);

    const pending = desktopAssemblyBroker.requestTimelineAssembly(sessionId, {
      projectDir: '/tmp/demo.dhee',
      timelineItems: [
        {
          type: 'video',
          path: '/tmp/demo.dhee/assets/videos/scene-1.mp4',
          duration: 5,
          startTime: 0,
          endTime: 5,
        },
      ],
      outputIntent: 'final_video',
      outputName: 'final_video',
    });

    const outbound = socket.sent
      .map((payload) => JSON.parse(payload))
      .find((payload) => payload.type === 'timeline_assembly_request');
    expect(outbound).toMatchObject({
      sessionId,
      type: 'timeline_assembly_request',
      data: {
        projectDir: '/tmp/demo.dhee',
        outputIntent: 'final_video',
        outputName: 'final_video',
      },
    });

    socket.emit(
      'message',
      JSON.stringify({
        type: 'timeline_assembly_result',
        data: {
          requestId: outbound.data.requestId,
          status: 'completed',
          outputPath: '/tmp/demo.dhee/assets/final_video/final_video.mp4',
          duration: 5,
          artifactId: 'final-video-1',
          manifestRelativePath: 'assets/final_video/final_video.mp4',
        },
      }),
    );

    await expect(pending).resolves.toMatchObject({
      requestId: outbound.data.requestId,
      status: 'completed',
      artifactId: 'final-video-1',
    });

    manager.shutdown();
    desktopAssemblyBroker.detachSession(sessionId);
  });

  it('rejects pending desktop assembly requests when the websocket disconnects', async () => {
    const manager = new ConversationManager({ llmConfig: {} });
    const handler = new WebSocketHandler(manager, { serverMode: 'remote' });
    const socket = new FakeSocket();

    handler.handleConnection(
      socket as never,
      '203.0.113.5',
      undefined,
      undefined,
      {
        desktopAssembly: true,
        desktopRemotion: false,
      },
    );

    const sessionId = JSON.parse(socket.sent[0] ?? '{}').sessionId as string;
    const pending = desktopAssemblyBroker.requestTimelineAssembly(
      sessionId,
      {
        projectDir: '/tmp/demo.dhee',
        timelineItems: [
          {
            type: 'video',
            path: '/tmp/demo.dhee/assets/videos/scene-1.mp4',
            duration: 5,
            startTime: 0,
            endTime: 5,
          },
        ],
        outputIntent: 'final_video',
        outputName: 'final_video',
      },
      { timeoutMs: 30_000 },
    );

    socket.emit('close', 1006, Buffer.from(''));

    await expect(pending).rejects.toThrow('Desktop session disconnected.');

    manager.shutdown();
  });
});
