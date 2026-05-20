import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  ProjectStateCache,
  createRemoteSession,
  runInSession,
} from '../../src/core/fs/index.js';
import type { FileStat, IFileSystem } from '../../src/core/fs/index.js';
import { getFakeVideoGenerationTools } from '../../src/tasks/video/fakeTools.js';
import { createProject } from '../../src/tasks/video/workflow/ProjectManager.js';
import { setActiveProjectDir } from '../../src/tasks/video/workflow/activeProject.js';

class FakeRemoteFs implements IFileSystem {
  readonly cache = new ProjectStateCache();
  readonly messages: Array<{ type: string; data: Record<string, unknown> }> = [];
  readonly socket = {
    readyState: 1,
    send: (payload: string) => {
      const parsed = JSON.parse(payload) as { type: string; data: Record<string, unknown> };
      this.messages.push(parsed);
    },
  };

  constructor(projectRoot: string) {
    this.cache.loadSnapshot({
      files: {},
      directories: [],
      projectRoot,
    });
  }

  getCache(): ProjectStateCache {
    return this.cache;
  }

  async readFile(): Promise<string> {
    throw new Error('Not implemented in fake remote fs');
  }

  async writeFile(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }

  async exists(): Promise<boolean> {
    throw new Error('Not implemented in fake remote fs');
  }

  async mkdir(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }

  async readdir(): Promise<string[]> {
    throw new Error('Not implemented in fake remote fs');
  }

  async stat(): Promise<FileStat> {
    throw new Error('Not implemented in fake remote fs');
  }

  async copyFile(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }

  async deleteFile(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }

  async deleteDir(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }

  async readFileBuffer(): Promise<Buffer> {
    throw new Error('Not implemented in fake remote fs');
  }

  async writeFileBuffer(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }

  async writeBatch(): Promise<void> {
    throw new Error('Not implemented in fake remote fs');
  }
}

function withRemoteProjectSession<T>(
  projectRoot: string,
  fn: (remoteFs: FakeRemoteFs) => T,
): T {
  const remoteFs = new FakeRemoteFs(projectRoot);
  return runInSession(createRemoteSession('test-session', projectRoot, remoteFs), () =>
    fn(remoteFs),
  );
}

describe('fake generation tools remote prompt resolution', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(join(os.tmpdir(), 'dhee-fake-tools-'));
    projectRoot = join(tempRoot, 'remote-fake-test.dhee');
    setActiveProjectDir(projectRoot);
  });

  afterEach(() => {
    setActiveProjectDir('default.dhee');
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reads relative prompt files from the active remote project', async () => {
    await withRemoteProjectSession(projectRoot, async remoteFs => {
      createProject('A boy playing football', 'cinematic_realism', tempRoot);
      fs.mkdirSync(join(projectRoot, 'assets', 'images'), { recursive: true });

      remoteFs.cache.markDirectory('prompts');
      remoteFs.cache.markDirectory('prompts/images');
      remoteFs.cache.markDirectory('prompts/images/shots');
      remoteFs.cache.setFile(
        'prompts/images/shots/scene-1-shot-1.prompt.md',
        '**Image Prompt:**\nLeo framed against the empty field from the remote cache.',
      );

      const fakeGenerateImage = getFakeVideoGenerationTools().find(
        tool => tool.name === 'generate_image',
      );

      const result = await fakeGenerateImage?.handler?.({
        scene_number: 1,
        image_type: 'scene',
        prompt_file: 'prompts/images/shots/scene-1-shot-1.prompt.md',
      }) as {
        status: string;
        params?: { prompt?: string };
      };

      expect(result.status).toBe('submitted');
      expect(result.params?.prompt).toContain(
        'Leo framed against the empty field from the remote cache.',
      );
    });
  });
});
