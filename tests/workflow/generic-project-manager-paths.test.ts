import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import { GenericProjectManager } from '../../src/tasks/video/workflow/GenericProjectManager.js';
import { setActiveProjectDir } from '../../src/tasks/video/workflow/activeProject.js';
import { listProjectFilesTool } from '../../src/tasks/video/workflow/FileTools.js';
import { initializeTemplates } from '../../src/templates/index.js';

describe('Generic project manager path handling', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(join(os.tmpdir(), 'dhee-generic-path-'));
    projectRoot = join(tempRoot, 'desktop-project.dhee');
    initializeTemplates();
  });

  afterEach(() => {
    setActiveProjectDir('default.dhee');
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses an absolute active project directory as-is', async () => {
    setActiveProjectDir(projectRoot);
    const manager = new GenericProjectManager('/ignored-base-path');

    await manager.createProject({
      title: 'Desktop absolute path project',
      templateId: 'narrative',
      inputContent: 'A child and a cat play football together.',
    });

    expect(fs.existsSync(join(projectRoot, 'project.json'))).toBe(true);
    expect(manager.projectExistsSync()).toBe(true);

    const loaded = manager.loadProjectQuick();
    expect(loaded.title).toBe('Desktop absolute path project');
    expect(loaded.templateId).toBe('narrative');
  });

  it('reports the real project directory in list_project_files', async () => {
    setActiveProjectDir(projectRoot);
    const manager = new GenericProjectManager('/ignored-base-path');

    await manager.createProject({
      title: 'Directory listing project',
      templateId: 'narrative',
      inputContent: 'A boy playing football with a cat.',
    });

    const result = await listProjectFilesTool.handler?.({});
    expect(result).toMatchObject({
      status: 'success',
      project_directory: projectRoot,
    });
  });
});
