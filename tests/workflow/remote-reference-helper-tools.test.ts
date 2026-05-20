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
import { useInputAsReferenceTool } from '../../src/core/tools/builtin/inputTools.js';
import { validateAndSanitizeReferenceImages } from '../../src/core/tools/builtin/referenceImageValidator.js';
import {
  createProject,
  loadProject,
  saveProject,
} from '../../src/tasks/video/workflow/ProjectManager.js';
import { setActiveProjectDir } from '../../src/tasks/video/workflow/activeProject.js';

class FakeRemoteFs implements IFileSystem {
  readonly cache = new ProjectStateCache();
  readonly messages: Array<{ type: string; data: Record<string, unknown> }> = [];
  readonly projectRoot: string;
  readonly socket = {
    readyState: 1,
    send: (payload: string) => {
      const parsed = JSON.parse(payload) as { type: string; data: Record<string, unknown> };
      this.messages.push(parsed);
    },
  };

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
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

  async exists(targetPath: string): Promise<boolean> {
    const normalized = this.normalizePath(targetPath);
    return this.cache.getFile(normalized) != null;
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

  private normalizePath(targetPath: string): string {
    if (targetPath.startsWith(this.projectRoot)) {
      return targetPath.slice(this.projectRoot.length + 1).replace(/\\/g, '/');
    }
    return targetPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
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

describe('remote reference helper tools', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(join(os.tmpdir(), 'dhee-remote-helper-'));
    projectRoot = join(tempRoot, 'remote-helper-test.dhee');
    setActiveProjectDir(projectRoot);
    createProject('A helper test', 'cinematic_realism', tempRoot);
  });

  afterEach(() => {
    setActiveProjectDir('default.dhee');
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('use_input_as_reference accepts remote-backed image inputs', async () => {
    await withRemoteProjectSession(projectRoot, async remoteFs => {
      createProject('A helper test', 'cinematic_realism', tempRoot);
      remoteFs.cache.markDirectory('assets');
      remoteFs.cache.markDirectory('assets/images');
      remoteFs.cache.setFile('assets/images/remote-input.png', 'remote-image');

      const project = loadProject(tempRoot)!;
      project.inputs = [
        {
          id: 'input_remote_image',
          source: { type: 'local_file', value: 'assets/images/remote-input.png' },
          mediaType: 'image',
          purpose: 'character_ref',
          metadata: { addedAt: Date.now() },
          processing: {
            status: 'completed',
            localPath: 'assets/images/remote-input.png',
          },
        },
      ];
      saveProject(project, tempRoot);

      const result = await useInputAsReferenceTool.handler?.({
        input_id: 'input_remote_image',
        reference_type: 'character',
      });

      expect(result).toMatchObject({
        status: 'success',
        reference_path: 'assets/images/remote-input.png',
      });
    });
  });

  it('referenceImageValidator preserves remote-backed project asset paths', async () => {
    await withRemoteProjectSession(projectRoot, async remoteFs => {
      createProject('A helper test', 'cinematic_realism', tempRoot);
      remoteFs.cache.markDirectory('assets');
      remoteFs.cache.markDirectory('assets/images');
      remoteFs.cache.setFile('assets/images/remote-ref.png', 'remote-ref');

      const input = JSON.stringify({
        referenceImages: ['assets/images/remote-ref.png', 'assets/images/missing-ref.png'],
        shots: [
          {
            referenceImages: ['assets/images/remote-ref.png'],
          },
        ],
      });

      const result = validateAndSanitizeReferenceImages(input);
      const parsed = JSON.parse(result.sanitized) as {
        referenceImages: string[];
        shots: Array<{ referenceImages: string[] }>;
      };

      expect(parsed.referenceImages).toEqual(['assets/images/remote-ref.png']);
      expect(parsed.shots[0]?.referenceImages).toEqual(['assets/images/remote-ref.png']);
      expect(result.removedPaths).toEqual(['assets/images/missing-ref.png']);
    });
  });
});
