import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IFileSystem } from '../../../../src/core/fs/IFileSystem.js';
import { ProjectStateCache } from '../../../../src/core/fs/ProjectStateCache.js';
import {
  createRemoteSession,
  runInSession,
} from '../../../../src/core/fs/SessionContext.js';

const comfyState = vi.hoisted(() => ({
  downloadCalls: [] as Array<{ filename: string; subfolder: string; type: string }>,
}));

vi.mock('../../../../src/services/comfyui/index.js', () => {
  class MockComfyUIClient {
    async queueWorkflow() {
      return { promptId: 'prompt-1', clientId: 'client-1' };
    }

    async waitForCompletionWS() {
      return { status: 'completed', prompt_id: 'prompt-1' };
    }

    async queueAndWaitWS() {
      // Combined WS-first variant on the production client; avoids the
      // cloud cache leak (foreign outputs captured when our prompt hash
      // matches a stranger's earlier submission). Mock returns the same
      // shape so the provider exercises the same path.
      return {
        result: { status: 'completed', prompt_id: 'prompt-1' },
        promptId: 'prompt-1',
        clientId: 'client-1',
        outputs: [
          {
            filename: 'remote-image.png',
            subfolder: '',
            type: 'output',
          },
        ],
      };
    }

    async getOutputImages() {
      return [
        {
          filename: 'remote-image.png',
          subfolder: '',
          type: 'output',
        },
      ];
    }

    async downloadOutput(filename: string, subfolder: string, type: string) {
      comfyState.downloadCalls.push({ filename, subfolder, type });
      return {
        buffer: Buffer.from('remote-image-bytes'),
        filename,
        subfolder,
        type,
      };
    }

    async downloadImage() {
      throw new Error('downloadImage should not be used for remote-safe persistence');
    }

    async uploadImage() {
      return { name: 'uploaded.png', subfolder: '', type: 'input' };
    }
  }

  return {
    ComfyUIClient: MockComfyUIClient,
    loadWorkflowTemplate: () => ({ nodes: [] }),
    parameterizeWorkflowByName: () => ({}),
    getRegistry: () => ({
      get: () => ({ filename: 'mock-workflow.json' }),
    }),
    isComfyCloudUrl: (value: string) => value === 'https://cloud.comfy.org',
  };
});

import { ComfyUIProvider } from '../../../../src/services/providers/comfyui/ComfyUIProvider.js';

function createRemoteFs(sentPayloads: string[]) {
  const cache = new ProjectStateCache();

  return {
    socket: {
      readyState: 1,
      send(payload: string) {
        sentPayloads.push(payload);
      },
    },
    getCache: () => cache,
    readFile: async () => '',
    writeFile: async () => {},
    exists: async () => false,
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: false, isDirectory: false, size: 0 }),
    copyFile: async () => {},
    deleteFile: async () => {},
    deleteDir: async () => {},
    readFileBuffer: async () => Buffer.alloc(0),
    writeFileBuffer: async () => {},
    writeBatch: async () => {},
  } satisfies IFileSystem & {
    socket: { readyState: number; send(payload: string): void };
    getCache(): ProjectStateCache;
  };
}

describe('ComfyUIProvider remote persistence', () => {
  let tempRoot: string;
  const previousBaseUrl = process.env['COMFYUI_BASE_URL'];

  beforeEach(() => {
    comfyState.downloadCalls.length = 0;
    tempRoot = fs.mkdtempSync(join(os.tmpdir(), 'dhee-comfy-provider-'));
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org';
  });

  afterEach(() => {
    if (previousBaseUrl === undefined) {
      delete process.env['COMFYUI_BASE_URL'];
    } else {
      process.env['COMFYUI_BASE_URL'] = previousBaseUrl;
    }
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes downloaded outputs through remote project file operations', async () => {
    const sentPayloads: string[] = [];
    const projectRoot = join(tempRoot, 'remote-project.dhee');
    const remoteFs = createRemoteFs(sentPayloads);
    const provider = new ComfyUIProvider();

    const result = await runInSession(
      createRemoteSession('remote-session', projectRoot, remoteFs),
      async () =>
        provider.generateImage({
          prompt: 'A cinematic portrait of a football player.',
          outputDir: join(projectRoot, 'assets', 'images'),
          filenamePrefix: 'CharRef_Leo',
        }),
    );

    expect(comfyState.downloadCalls).toEqual([
      {
        filename: 'remote-image.png',
        subfolder: '',
        type: 'output',
      },
    ]);

    const messages = sentPayloads.map((payload) => JSON.parse(payload));
    const mkdirMessages = messages.filter(
      (message) => message.type === 'file_mkdir_command',
    );
    const writeMessage = messages.find(
      (message) => message.type === 'file_write_buffer_command',
    );

    expect(mkdirMessages.length).toBeGreaterThan(0);
    expect(writeMessage).toBeDefined();
    expect(writeMessage.data.path).toMatch(
      /^assets\/images\/CharRef_Leo_[A-Za-z0-9_-]+\.png$/,
    );
    expect(
      Buffer.from(writeMessage.data.data as string, 'base64').toString(),
    ).toBe('remote-image-bytes');
    expect(result.filePath).toMatch(
      /remote-project\.dhee\/assets\/images\/CharRef_Leo_[A-Za-z0-9_-]+\.png$/,
    );
  });
});
