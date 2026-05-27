/**
 * Tests for ProjectManager - project lifecycle and file management.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  projectExists,
  createProject,
  loadProject,
  saveProject,
  deleteProject,
  writeProjectFile,
  readProjectFile,
  getProjectDir,
  getOriginalInput,
} from '../../src/tasks/video/workflow/index.js';

// Use a temp directory for tests
const TEST_BASE_PATH = join(process.cwd(), 'test-temp-project');

describe('ProjectManager', () => {
  beforeEach(() => {
    // Clean up before each test
    if (existsSync(TEST_BASE_PATH)) {
      rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    }
    mkdirSync(TEST_BASE_PATH, { recursive: true });
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(TEST_BASE_PATH)) {
      rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    }
  });

  describe('projectExists', () => {
    it('returns false when no project exists', () => {
      expect(projectExists(TEST_BASE_PATH)).toBe(false);
    });

    it('returns true when project exists', () => {
      createProject('Test story', TEST_BASE_PATH);
      expect(projectExists(TEST_BASE_PATH)).toBe(true);
    });
  });

  describe('createProject', () => {
    it('creates project.json with correct structure', () => {
      const project = createProject('A robot learning to dance', TEST_BASE_PATH);

      expect(project.id).toMatch(/^proj-/);
      // Original input is now stored in a separate file
      expect(project.originalInputFile).toBe('original_input.md');
      expect(getOriginalInput(project, TEST_BASE_PATH)).toBe('A robot learning to dance');
      expect(project.currentPhase).toBe('plot');
      expect(project.characters).toEqual([]);
      expect(project.scenes).toEqual([]);
    });

    it('creates directory structure without empty plan files', () => {
      createProject('Test story', TEST_BASE_PATH);
      const projectDir = getProjectDir(TEST_BASE_PATH);

      // Directories should exist
      expect(existsSync(join(projectDir, 'plans'))).toBe(true);
      expect(existsSync(join(projectDir, 'characters'))).toBe(true);
      expect(existsSync(join(projectDir, 'settings'))).toBe(true);
      expect(existsSync(join(projectDir, 'assets'))).toBe(true);

      // Plan files should NOT exist (created on first write)
      expect(existsSync(join(projectDir, 'plans', 'plot.md'))).toBe(false);
      expect(existsSync(join(projectDir, 'plans', 'story.md'))).toBe(false);
      expect(existsSync(join(projectDir, 'plans', 'scenes.md'))).toBe(false);

      // Assets manifest should exist
      expect(existsSync(join(projectDir, 'assets', 'manifest.json'))).toBe(true);
    });
  });

  describe('loadProject', () => {
    it('returns null when no project exists', () => {
      expect(loadProject(TEST_BASE_PATH)).toBeNull();
    });

    it('loads existing project correctly', () => {
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);

      expect(project).not.toBeNull();
      expect(project?.originalInputFile).toBe('original_input.md');
      expect(getOriginalInput(project!, TEST_BASE_PATH)).toBe('Test story');
    });
  });

  describe('deleteProject', () => {
    it('returns false when no project exists', () => {
      expect(deleteProject(TEST_BASE_PATH)).toBe(false);
    });

    it('deletes existing project and returns true', () => {
      createProject('Test story', TEST_BASE_PATH);
      expect(projectExists(TEST_BASE_PATH)).toBe(true);

      const result = deleteProject(TEST_BASE_PATH);

      expect(result).toBe(true);
      expect(projectExists(TEST_BASE_PATH)).toBe(false);
    });

    it('removes entire .dhee directory', () => {
      createProject('Test story', TEST_BASE_PATH);
      const projectDir = getProjectDir(TEST_BASE_PATH);

      // Write some files
      writeProjectFile('plans/plot.md', '# Plot', TEST_BASE_PATH);
      writeProjectFile('plans/story.md', '# Story', TEST_BASE_PATH);

      expect(existsSync(projectDir)).toBe(true);

      deleteProject(TEST_BASE_PATH);

      expect(existsSync(projectDir)).toBe(false);
    });
  });

  describe('writeProjectFile', () => {
    it('creates file on first write (not at project creation)', () => {
      createProject('Test story', TEST_BASE_PATH);
      const projectDir = getProjectDir(TEST_BASE_PATH);
      const plotPath = join(projectDir, 'plans', 'plot.md');

      // File should not exist after project creation
      expect(existsSync(plotPath)).toBe(false);

      // Write content
      writeProjectFile('plans/plot.md', '# My Plot\n\nA great story.', TEST_BASE_PATH);

      // Now file should exist with content
      expect(existsSync(plotPath)).toBe(true);
      expect(readFileSync(plotPath, 'utf-8')).toBe('# My Plot\n\nA great story.');
    });

    it('overwrites existing file', () => {
      createProject('Test story', TEST_BASE_PATH);

      writeProjectFile('plans/plot.md', 'First version', TEST_BASE_PATH);
      writeProjectFile('plans/plot.md', 'Second version', TEST_BASE_PATH);

      const content = readProjectFile('plans/plot.md', TEST_BASE_PATH);
      expect(content).toBe('Second version');
    });
  });

  describe('readProjectFile', () => {
    it('returns null for non-existent file', () => {
      createProject('Test story', TEST_BASE_PATH);
      expect(readProjectFile('plans/plot.md', TEST_BASE_PATH)).toBeNull();
    });

    it('returns content for existing file', () => {
      createProject('Test story', TEST_BASE_PATH);
      writeProjectFile('plans/plot.md', 'Test content', TEST_BASE_PATH);

      expect(readProjectFile('plans/plot.md', TEST_BASE_PATH)).toBe('Test content');
    });
  });

  // Regression pin for the 2026-05-03 "every restart re-runs Expand
  // Characters" bug: saveProject's hand-rolled `orderedProject`
  // omitted `executorState`, so any caller that round-tripped a
  // project through loadProject → saveProject silently wiped the
  // dependency-graph state. Configure_project (called every time the
  // user opened a project from the desktop) was one such caller, and
  // it nuked all completed nodes on every open.
  describe('saveProject preserves executor state', () => {
    it('round-trips executorState through saveProject + loadProject', () => {
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);
      expect(project).not.toBeNull();
      // Stub a representative executorState shape — the contract is
      // "whatever was on the project, comes back". We don't depend
      // on the executor's real shape here.
      const stubExecutorState = {
        nodes: {
          'plot:plot': {
            id: 'plot:plot',
            typeId: 'plot',
            status: 'completed',
            outputPath: 'chapters/chapter_1/plans/plot.md',
          },
          'story:story': {
            id: 'story:story',
            typeId: 'story',
            status: 'completed',
            outputPath: 'chapters/chapter_1/plans/story.md',
          },
        },
        completedCount: 2,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).executorState = stubExecutorState;
      saveProject(project!, TEST_BASE_PATH);

      const reloaded = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reloaded as any)?.executorState).toEqual(stubExecutorState);
    });

    it('preserves executorState across multiple round-trips (idempotent)', () => {
      createProject('Test story', TEST_BASE_PATH);
      let project = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).executorState = { nodes: { 'a': { id: 'a', status: 'completed' } } };

      // 5 sequential save/load cycles — simulates the user opening,
      // configure_project firing, and the executor running again.
      for (let i = 0; i < 5; i++) {
        saveProject(project!, TEST_BASE_PATH);
        project = loadProject(TEST_BASE_PATH);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((project as any)?.executorState?.nodes?.['a']?.status).toBe(
        'completed',
      );
    });

    it('writes executorState directly to project.json on disk (not just in memory)', () => {
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).executorState = {
        nodes: { 'extract_collections:extract_collections': { status: 'completed' } },
      };
      saveProject(project!, TEST_BASE_PATH);

      const onDisk = JSON.parse(
        readFileSync(join(getProjectDir(TEST_BASE_PATH), 'project.json'), 'utf8'),
      );
      expect(onDisk.executorState).toBeDefined();
      expect(
        onDisk.executorState.nodes['extract_collections:extract_collections']
          .status,
      ).toBe('completed');
    });

    it('preserves renderMethod across save/load (dispatcher routing field)', () => {
      // renderMethod is declared on core/project/projectTypes.ts:ProjectFile
      // but NOT on the legacy workflow/types.ts ProjectFile that saveProject
      // is typed against. Before the passthrough fix, every executor save
      // silently dropped this field — leaving prompt_relay projects
      // running the legacy shot_by_shot executor.
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).renderMethod = 'prompt_relay';
      saveProject(project!, TEST_BASE_PATH);

      const onDisk = JSON.parse(
        readFileSync(join(getProjectDir(TEST_BASE_PATH), 'project.json'), 'utf8'),
      );
      expect(onDisk.renderMethod).toBe('prompt_relay');

      // Also exercise the round-trip path the dispatcher actually uses.
      const reloaded = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reloaded as any)?.renderMethod).toBe('prompt_relay');
    });

    it('preserves features (per-project feature flags) across save/load', () => {
      // features lives under project.features.* and drives per-project
      // opt-ins like skipHoldingBeatLF. Same regression class as
      // renderMethod — must survive executor saves.
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).features = { skipHoldingBeatLF: true };
      saveProject(project!, TEST_BASE_PATH);

      const onDisk = JSON.parse(
        readFileSync(join(getProjectDir(TEST_BASE_PATH), 'project.json'), 'utf8'),
      );
      expect(onDisk.features).toEqual({ skipHoldingBeatLF: true });
    });

    it('preserves bundleSource across save/load (bundle architecture dispatch field)', () => {
      // bundleSource tells executeRunTo to route through
      // runProjectViaBundle (the bundle architecture) vs the legacy
      // executor. Same regression class as renderMethod — must
      // survive executor / saveProject calls.
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).bundleSource = 'built-in:ltx_prompt_relay';
      saveProject(project!, TEST_BASE_PATH);

      const onDisk = JSON.parse(
        readFileSync(join(getProjectDir(TEST_BASE_PATH), 'project.json'), 'utf8'),
      );
      expect(onDisk.bundleSource).toBe('built-in:ltx_prompt_relay');

      // Round-trip via loadProject too.
      const reloaded = loadProject(TEST_BASE_PATH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reloaded as any)?.bundleSource).toBe('built-in:ltx_prompt_relay');
    });

    it('preserves walkState across save/load (walker owns this; saveProject must passthrough)', () => {
      createProject('Test story', TEST_BASE_PATH);
      const project = loadProject(TEST_BASE_PATH);
      const ws = {
        bundleSource: 'built-in:ltx_prompt_relay',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: {
          scene_clip: { status: 'pending' },
          'scene_clip:scene_1_chunk_1': { status: 'completed', outputPath: 'x.mp4' },
        },
        lastInvalidatedIds: [],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (project as any).walkState = ws;
      saveProject(project!, TEST_BASE_PATH);

      const onDisk = JSON.parse(
        readFileSync(join(getProjectDir(TEST_BASE_PATH), 'project.json'), 'utf8'),
      );
      expect(onDisk.walkState).toEqual(ws);
    });
  });
});

describe('Project Continuation Flow', () => {
  beforeEach(() => {
    if (existsSync(TEST_BASE_PATH)) {
      rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    }
    mkdirSync(TEST_BASE_PATH, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_BASE_PATH)) {
      rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    }
  });

  it('can detect existing project on startup', () => {
    // Simulate first session - create project
    const project1 = createProject('A robot story', TEST_BASE_PATH);
    const projectId = project1.id;

    // Simulate new session - check for existing
    expect(projectExists(TEST_BASE_PATH)).toBe(true);

    const loadedProject = loadProject(TEST_BASE_PATH);
    expect(loadedProject?.id).toBe(projectId);
    expect(getOriginalInput(loadedProject!, TEST_BASE_PATH)).toBe('A robot story');
  });

  it('can continue existing project with its state', () => {
    // First session - create and update project
    createProject('A robot story', TEST_BASE_PATH);
    writeProjectFile('plans/plot.md', '# Robot Dance Plot\n\nA robot learns to dance.', TEST_BASE_PATH);

    // New session - load and continue
    const continued = loadProject(TEST_BASE_PATH);
    expect(getOriginalInput(continued!, TEST_BASE_PATH)).toBe('A robot story');

    const plotContent = readProjectFile('plans/plot.md', TEST_BASE_PATH);
    expect(plotContent).toContain('Robot Dance Plot');
  });

  it('can start new project after deleting existing', () => {
    // Create first project
    createProject('First story', TEST_BASE_PATH);
    writeProjectFile('plans/plot.md', 'First plot', TEST_BASE_PATH);

    // Delete and create new
    deleteProject(TEST_BASE_PATH);
    expect(projectExists(TEST_BASE_PATH)).toBe(false);

    const newProject = createProject('Second story', TEST_BASE_PATH);
    expect(getOriginalInput(newProject, TEST_BASE_PATH)).toBe('Second story');

    // Old content should be gone
    expect(readProjectFile('plans/plot.md', TEST_BASE_PATH)).toBeNull();
  });

  it('preserves project state across multiple sessions', () => {
    // Session 1: Create project and plot
    createProject('Epic tale', TEST_BASE_PATH);
    writeProjectFile('plans/plot.md', '# Act 1\nIntroduction', TEST_BASE_PATH);

    // Session 2: Add more content
    const loaded1 = loadProject(TEST_BASE_PATH);
    expect(loaded1).not.toBeNull();
    writeProjectFile('plans/story.md', '# Full Story\nOnce upon a time...', TEST_BASE_PATH);

    // Session 3: Verify all content persists
    const loaded2 = loadProject(TEST_BASE_PATH);
    expect(getOriginalInput(loaded2!, TEST_BASE_PATH)).toBe('Epic tale');
    expect(readProjectFile('plans/plot.md', TEST_BASE_PATH)).toContain('Act 1');
    expect(readProjectFile('plans/story.md', TEST_BASE_PATH)).toContain('Once upon a time');
  });
});
