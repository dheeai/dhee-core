import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

import {
  createProject,
  getProjectDir,
  loadProject,
} from '../../src/tasks/video/workflow/ProjectManager.js';
import { setActiveProjectDir } from '../../src/tasks/video/workflow/activeProject.js';

describe('Project root stability', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(join(os.tmpdir(), 'dhee-project-root-'));
    projectRoot = join(tempRoot, 'desktop-root.dhee');
    setActiveProjectDir(projectRoot);
  });

  afterEach(() => {
    setActiveProjectDir('default.dhee');
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps the configured absolute project root when creating a project', () => {
    const project = createProject('A boy playing football');

    expect(getProjectDir()).toBe(projectRoot);
    expect(project.id).toBe(loadProject()?.id);
    expect(fs.existsSync(join(projectRoot, 'project.json'))).toBe(true);
    expect(fs.existsSync(join(projectRoot, 'original_input.md'))).toBe(true);
  });

  // The previous "called via updateProjectTool" idempotency case lived
  // in a tool that was removed when pi-agent took over project setup
  // (see `dhee_new`). The "already_exists" decision is now made by
  // pi at a different layer; the in-process `createProject` itself
  // doesn't no-op on a populated root and shouldn't be tested as if
  // it does. Coverage for the new flow lives next to `dhee_new`.
});
