import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  createProject,
  isProjectCompatible,
  loadProject,
  PROJECT_VERSION,
} from '../../src/tasks/video/workflow/index.js';
import { GenericProjectManager } from '../../src/tasks/video/workflow/GenericProjectManager.js';
import { setActiveProjectDir } from '../../src/tasks/video/workflow/activeProject.js';
import { initializeTemplates } from '../../src/templates/index.js';

describe('Project version compatibility', () => {
  let testBasePath: string;

  beforeEach(() => {
    testBasePath = fs.mkdtempSync(join(os.tmpdir(), 'dhee-version-'));
    initializeTemplates();
  });

  afterEach(() => {
    setActiveProjectDir('default.dhee');
    if (fs.existsSync(testBasePath)) {
      fs.rmSync(testBasePath, { recursive: true, force: true });
    }
  });

  it('loads a workflow project when its stored version matches the current version', () => {
    createProject('Version check story', testBasePath);

    const project = loadProject(testBasePath);

    expect(project).not.toBeNull();
    expect(project?.version).toBe(PROJECT_VERSION);
    expect(isProjectCompatible(testBasePath)).toEqual({
      compatible: true,
      version: PROJECT_VERSION,
    });
  });

  it('uses the current version in the generic manager incompatibility error', async () => {
    setActiveProjectDir('generic-version-test.dhee');
    const manager = new GenericProjectManager(testBasePath);

    await manager.createProject({
      title: 'Generic version check',
      templateId: 'narrative',
      inputContent: 'A short story seed.',
    });

    const projectFile = join(testBasePath, 'generic-version-test.dhee', 'project.json');
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
    project.version = '1.0';
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    const reloadedManager = new GenericProjectManager(testBasePath);

    await expect(reloadedManager.loadProject()).rejects.toThrow(
      `Incompatible project version: 1.0. Expected: ${PROJECT_VERSION}`
    );
  });
});
