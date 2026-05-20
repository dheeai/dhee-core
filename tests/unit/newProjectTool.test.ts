/**
 * Tests for the pi-agent `dhee_new` tool — the in-process wrapper
 * around createProjectInProcess that the chat panel invokes when a user
 * says "create a new project". Verifies validation, params → core call
 * mapping, and response shape.
 *
 * Core behavior (folder + project.json shape) is covered separately in
 * tests/unit/createProjectInProcess.test.ts. This file focuses on the
 * tool surface itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dheeNew } from '../../src/agent/pi/tools/newProject.js';

let projectsDir: string;

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), 'dhee-new-tool-'));
  process.env['dhee_PROJECTS_DIR'] = projectsDir;
});

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  delete process.env['dhee_PROJECTS_DIR'];
});

function executeNew(params: Record<string, unknown>) {
  return dheeNew.execute(
    'call-id-1',
    params as never,
    undefined as never,
    undefined as never,
    {} as never,
  );
}

describe('pi-agent dheeNew tool', () => {
  // ── Validation paths ─────────────────────────────────────────────

  it('returns failure when style is missing', async () => {
    const r = await executeNew({
      name: 'p',
      input: 'A story.',
      duration: 60,
    });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /style is required/,
    );
    expect(existsSync(join(projectsDir, 'p.dhee'))).toBe(false);
  });

  it('returns failure when duration is missing', async () => {
    const r = await executeNew({
      name: 'p',
      input: 'A story.',
      style: 'live',
    });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /duration is required/,
    );
  });

  it('returns failure when input is missing', async () => {
    const r = await executeNew({
      name: 'p',
      style: 'live',
      duration: 60,
    });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /input is required/,
    );
  });

  it('returns failure on whitespace-only input', async () => {
    const r = await executeNew({
      name: 'p',
      input: '   \n  ',
      style: 'live',
      duration: 60,
    });
    expect((r.details as { status: string }).status).toBe('failed');
  });

  it('returns failure on unknown style alias (not thrown)', async () => {
    const r = await executeNew({
      name: 'p',
      input: 'idea',
      style: 'totally-made-up',
      duration: 60,
    });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /Failed to create project.*Unknown style/,
    );
  });

  it('returns failure on duplicate project name', async () => {
    const ok = await executeNew({
      name: 'dup',
      input: 'idea',
      style: 'live',
      duration: 60,
    });
    expect((ok.details as { status: string }).status).toBe('completed');

    const r = await executeNew({
      name: 'dup',
      input: 'idea2',
      style: 'live',
      duration: 60,
    });
    expect((r.details as { status: string }).status).toBe('failed');
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(
      /already exists/,
    );
  });

  // ── Happy path ───────────────────────────────────────────────────

  it('creates the project on disk and returns completed details', async () => {
    const r = await executeNew({
      name: 'noir',
      input: 'A noir detective in 1940s LA.',
      style: 'live',
      duration: 60,
    });
    const d = r.details as {
      status: string;
      projectDir?: string;
      resolvedStyle?: string;
      inputType?: string;
      initialPhase?: string;
    };
    expect(d.status).toBe('completed');
    expect(d.projectDir).toBe(join(projectsDir, 'noir.dhee'));
    expect(d.resolvedStyle).toBe('cinematic_realism');
    expect(d.initialPhase).toBeDefined();

    // Side effects on disk.
    expect(existsSync(d.projectDir!)).toBe(true);
    expect(existsSync(join(d.projectDir!, 'project.json'))).toBe(true);
    expect(existsSync(join(d.projectDir!, 'original_input.md'))).toBe(true);

    const project = JSON.parse(
      readFileSync(join(d.projectDir!, 'project.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(project['title']).toBe('noir');
    expect(project['style']).toBe('cinematic_realism');
    expect(project['targetDuration']).toBe(60);
  });

  it('passes templateId through to the created project', async () => {
    const r = await executeNew({
      name: 'p',
      input: 'idea',
      style: 'live',
      duration: 30,
      template: 'narrative',
    });
    const d = r.details as { projectDir?: string };
    const project = JSON.parse(
      readFileSync(join(d.projectDir!, 'project.json'), 'utf8'),
    ) as { templateId?: string };
    expect(project.templateId).toBe('narrative');
  });

  it('uses anime style when alias resolves to it', async () => {
    const r = await executeNew({
      name: 'spirit',
      input: 'A wandering spirit.',
      style: 'anime',
      duration: 30,
    });
    const d = r.details as { resolvedStyle?: string };
    expect(d.resolvedStyle).toBe('anime');
  });

  it('writes original_input.md exactly as provided', async () => {
    const inputText = 'Line 1\nLine 2\n\nA paragraph.';
    const r = await executeNew({
      name: 'p',
      input: inputText,
      style: 'live',
      duration: 30,
    });
    const d = r.details as { projectDir: string };
    const onDisk = readFileSync(
      join(d.projectDir, 'original_input.md'),
      'utf8',
    );
    expect(onDisk).toBe(inputText);
  });

  it('response text summary mentions the resolved style + duration + initial phase', async () => {
    const r = await executeNew({
      name: 'p',
      input: 'A story.',
      style: 'live',
      duration: 45,
    });
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(text).toMatch(/Created project: p\.dhee/);
    expect(text).toMatch(/Style:\s+cinematic_realism/);
    expect(text).toMatch(/Duration:\s+45s/);
    expect(text).toMatch(/Initial phase/);
  });

  // ── existingDir param (dhee-desktop wizard handoff) ───────────
  // The desktop's chat-embedded wizard pre-creates a project folder
  // (NewProjectDialog) before pi-agent gets the kickoff message. The
  // tool must accept `existingDir` and forward it to the in-process
  // creator so the existing folder is initialized in place.

  describe('with existingDir', () => {
    it('initializes the pre-created folder and returns it as projectDir', async () => {
      const desktopDir = join(projectsDir, 'desktop_pre_created');
      mkdirSync(desktopDir, { recursive: true });
      writeFileSync(
        join(desktopDir, 'project.json'),
        JSON.stringify({ id: 'stub', title: 'desktop_pre_created' }),
      );

      const r = await executeNew({
        name: 'desktop_pre_created',
        input: 'A wizard-collected story.',
        style: 'live',
        duration: 60,
        existingDir: desktopDir,
      });

      const d = r.details as { status: string; projectDir?: string };
      expect(d.status).toBe('completed');
      expect(d.projectDir).toBe(desktopDir);
      // Did NOT create the default <name>.dhee sibling under projectsDir.
      expect(
        existsSync(join(projectsDir, 'desktop_pre_created.dhee')),
      ).toBe(false);
    });

    it('writes original_input.md into the existingDir', async () => {
      const desktopDir = join(projectsDir, 'check_input');
      mkdirSync(desktopDir, { recursive: true });

      const story = 'Two friends meet on a rooftop at midnight.';
      await executeNew({
        name: 'check_input',
        input: story,
        style: 'live',
        duration: 30,
        existingDir: desktopDir,
      });

      const onDisk = readFileSync(
        join(desktopDir, 'original_input.md'),
        'utf8',
      );
      expect(onDisk).toBe(story);
    });

    it('overwrites the desktop-stub project.json with v2.0 schema', async () => {
      const desktopDir = join(projectsDir, 'overwrite_stub');
      mkdirSync(desktopDir, { recursive: true });
      // Desktop's createDefaultBackendProject writes a stub like this.
      writeFileSync(
        join(desktopDir, 'project.json'),
        JSON.stringify({
          id: 'desktop-stub',
          title: 'overwrite_stub',
          version: '2.0',
        }),
      );

      await executeNew({
        name: 'overwrite_stub',
        input: 'idea',
        style: 'anime',
        duration: 45,
        template: 'narrative',
        existingDir: desktopDir,
      });

      const project = JSON.parse(
        readFileSync(join(desktopDir, 'project.json'), 'utf8'),
      ) as {
        style: string;
        targetDuration: number;
        templateId?: string;
        currentPhase?: string;
        phases?: unknown;
        title: string;
      };
      expect(project.style).toBe('anime');
      expect(project.targetDuration).toBe(45);
      expect(project.templateId).toBe('narrative');
      expect(project.currentPhase).toBeDefined();
      expect(project.phases).toBeDefined();
      expect(project.title).toBe('overwrite_stub');
    });

    it('returns a structured failure when existingDir does not exist', async () => {
      const r = await executeNew({
        name: 'p',
        input: 'idea',
        style: 'live',
        duration: 30,
        existingDir: join(projectsDir, 'never_created'),
      });
      expect((r.details as { status: string }).status).toBe('failed');
      expect((r.content as Array<{ text: string }>)[0].text).toMatch(
        /existingDir was passed but the folder does not exist/,
      );
    });

    it('still requires style/duration/input even with existingDir set', async () => {
      const dir = join(projectsDir, 'still_validates');
      mkdirSync(dir, { recursive: true });

      const noStyle = await executeNew({
        name: 'p',
        input: 'idea',
        duration: 30,
        existingDir: dir,
      });
      expect((noStyle.details as { status: string }).status).toBe('failed');

      const noDuration = await executeNew({
        name: 'p',
        input: 'idea',
        style: 'live',
        existingDir: dir,
      });
      expect((noDuration.details as { status: string }).status).toBe(
        'failed',
      );

      const noInput = await executeNew({
        name: 'p',
        style: 'live',
        duration: 30,
        existingDir: dir,
      });
      expect((noInput.details as { status: string }).status).toBe('failed');
    });
  });

  // ── No more shell-out ────────────────────────────────────────────

  it('does NOT depend on pnpm/tsx/scripts being available (in-process port)', async () => {
    // Hide PATH so any rogue child-process attempt would fail with
    // ENOENT rather than silently succeed against the dev environment.
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '/nonexistent';
    try {
      const r = await executeNew({
        name: 'in-process',
        input: 'idea',
        style: 'live',
        duration: 30,
      });
      expect((r.details as { status: string }).status).toBe('completed');
    } finally {
      process.env['PATH'] = originalPath;
    }
  });
});
