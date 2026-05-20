import { afterEach, describe, expect, it, vi } from 'vitest';
import EventEmitter from 'eventemitter3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ConversationManager } from '../../src/server/ConversationManager.js';
import { WebSocketHandler } from '../../src/server/WebSocketHandler.js';

class FakeAgent extends EventEmitter {
  initialize(): Promise<void> {
    return Promise.resolve();
  }

  run(): Promise<{ status: 'completed' }> {
    return Promise.resolve({ status: 'completed' });
  }

  stop(): void {}

  isRunning(): boolean {
    return false;
  }

  getToolNames(): string[] {
    return [];
  }

  setAutonomousMode(): void {}
}

describe('web UI timeline flow', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('forwards timeline_update events through ConversationManager', () => {
    const manager = new ConversationManager({
      llmConfig: {},
    });
    const agent = new FakeAgent();
    const onTimelineUpdate = vi.fn();

    (manager as any).setupEventListeners('sess-1', agent, { onTimelineUpdate });

    agent.emit('timeline_update', {
      timeline: { segments: [{ id: 'scene_1' }] },
    });

    expect(onTimelineUpdate).toHaveBeenCalledWith('sess-1', {
      timeline: { segments: [{ id: 'scene_1' }] },
    });

    manager.shutdown();
  });

  it('sends timeline_update when selecting a project with timeline.json', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dhee-webui-'));
    const projectDir = join(tempRoot, 'story-demo.dhee');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
      templateId: 'narrative',
      style: 'cinematic_realism',
      duration: 60,
    }));
    writeFileSync(join(projectDir, 'timeline.json'), JSON.stringify({
      version: '1.0',
      totalDuration: 60,
      defaultCompositingMode: 'replace',
      segments: [{ id: 'scene_1', label: 'Scene 1' }],
      globalLayers: [],
      validation: { isComplete: false, filledDuration: 0, gaps: [], warnings: [] },
    }));
    process.chdir(tempRoot);

    const conversationManager = {
      configureSessionForProject: vi.fn(),
      getSessionToolNames: vi.fn().mockReturnValue(['set_goal']),
    } as unknown as ConversationManager;

    const handler = new WebSocketHandler(conversationManager);
    const socket = {
      readyState: 1,
      send: vi.fn(),
    } as any;

    await (handler as any).handleSelectProject('sess-1', socket, 'story-demo');

    const sentMessages = socket.send.mock.calls.map(([payload]: [string]) => JSON.parse(payload));
    const timelineMessage = sentMessages.find((message: { type: string }) => message.type === 'timeline_update');

    expect(conversationManager.configureSessionForProject).toHaveBeenCalledWith(
      'sess-1',
      'narrative',
      'cinematic_realism',
      60,
      'story-demo.dhee',
    );
    expect(timelineMessage).toBeTruthy();
    expect(timelineMessage.data.timeline).toEqual(expect.objectContaining({
      totalDuration: 60,
      segments: [{ id: 'scene_1', label: 'Scene 1' }],
    }));

    handler.shutdown();
  });
});
