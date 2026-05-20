import { describe, expect, it } from 'vitest';

import {
  ProjectStateCache,
  createRemoteSession,
  runInSession,
} from '../../src/core/fs/index.js';
import type { FileStat, IFileSystem } from '../../src/core/fs/index.js';
import {
  createDefaultContentRegistry,
  loadProject,
  saveProject,
} from '../../src/tasks/video/workflow/ProjectManager.js';
import {
  projectExists,
  readProjectText,
  writeProjectBuffer,
  writeProjectText,
} from '../../src/tasks/video/workflow/projectFileIO.js';
import {
  loadTimeline,
  saveTimeline,
} from '../../src/core/timeline/TimelineManager.js';
import type { Timeline } from '../../src/core/timeline/types.js';

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

function createTimeline(): Timeline {
  return {
    version: '1.0',
    totalDuration: 6,
    defaultCompositingMode: 'replace',
    segments: [
      {
        id: 'segment_0',
        label: 'Scene 1',
        startTime: 0,
        endTime: 6,
        duration: 6,
        compositingMode: 'replace',
        fillStatus: 'empty',
        layers: [],
      },
    ],
    globalLayers: [],
    validation: {
      isComplete: false,
      filledDuration: 0,
      gaps: [],
      warnings: [],
    },
  };
}

describe('projectFileIO remote persistence', () => {
  it('writes project text through remote mkdir/write commands and cache', () => {
    const projectRoot = '/Users/indhicdev/Documents/test-dhee-dev/test-dhee-dev.dhee';

    withRemoteProjectSession(projectRoot, (remoteFs) => {
      writeProjectText('plans/plot.md', '# Plot\n\nSaved remotely');

      expect(remoteFs.messages).toHaveLength(2);
      expect(remoteFs.messages[0]).toMatchObject({
        type: 'file_mkdir_command',
        data: { path: 'plans' },
      });
      expect(remoteFs.messages[1]).toMatchObject({
        type: 'file_write_command',
        data: { path: 'plans/plot.md', content: '# Plot\n\nSaved remotely' },
      });
      expect(readProjectText('plans/plot.md')).toBe('# Plot\n\nSaved remotely');
      expect(projectExists('plans/plot.md')).toBe(true);
    });
  });

  it('persists project.json through remote file commands and reloads from cache', () => {
    const projectRoot = '/Users/indhicdev/Documents/test-dhee-dev/test-dhee-dev.dhee';

    withRemoteProjectSession(projectRoot, (remoteFs) => {
      saveProject({
        version: '2.0',
        id: 'proj_test',
        title: 'Remote Project',
        originalInputFile: 'original_input.md',
        style: 'cinematic_realism',
        inputType: 'idea',
        createdAt: 1,
        updatedAt: 1,
        currentPhase: 'plot',
        phases: {
          plot: { status: 'pending', completedAt: null },
        },
        content: createDefaultContentRegistry(),
        characters: [],
        settings: [],
        scenes: [],
        assets: [],
      });

      const reloadedProject = loadProject();

      expect(remoteFs.messages.at(-1)).toMatchObject({
        type: 'file_write_command',
        data: {
          path: 'project.json',
        },
      });
      expect(reloadedProject?.title).toBe('Remote Project');
      expect(readProjectText('project.json')).toContain('"title": "Remote Project"');
    });
  });

  it('writes binary project assets through remote buffer commands', () => {
    const projectRoot = '/Users/indhicdev/Documents/test-dhee-dev/test-dhee-dev.dhee';

    withRemoteProjectSession(projectRoot, (remoteFs) => {
      writeProjectBuffer('assets/images/frame.png', Buffer.from('binary-data'));

      expect(remoteFs.messages).toHaveLength(2);
      expect(remoteFs.messages[0]).toMatchObject({
        type: 'file_mkdir_command',
        data: { path: 'assets/images' },
      });
      expect(remoteFs.messages[1]).toMatchObject({
        type: 'file_write_buffer_command',
        data: {
          path: 'assets/images/frame.png',
          data: Buffer.from('binary-data').toString('base64'),
        },
      });
    });
  });

  it('persists timeline.json through remote project file commands and reloads from cache', () => {
    const projectRoot = '/Users/indhicdev/Documents/test-dhee-dev/test-dhee-dev.dhee';

    withRemoteProjectSession(projectRoot, (remoteFs) => {
      const timeline = createTimeline();

      saveTimeline(projectRoot, timeline);
      const reloaded = loadTimeline(projectRoot);

      expect(remoteFs.messages).toHaveLength(1);
      expect(remoteFs.messages[0]).toMatchObject({
        type: 'file_write_command',
        data: {
          path: 'timeline.json',
        },
      });
      expect(readProjectText('timeline.json')).toContain('"totalDuration": 6');
      expect(reloaded).toEqual(
        expect.objectContaining({
          totalDuration: 6,
          segments: [
            expect.objectContaining({
              id: 'segment_0',
              label: 'Scene 1',
            }),
          ],
        }),
      );
    });
  });
});
