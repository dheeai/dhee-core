/**
 * initializeProject — coverage for the pre-agent project bootstrap
 * that the Production Slate screen calls when the user clicks ROLL.
 *
 * Failure modes:
 *   1. Happy path: writes project.json + inputs/story.md, sets project-kind
 *      fields from caller inputs, applies bundle defaults where caller
 *      omitted.
 *   2. Caller-supplied story content is written verbatim to the bundle's
 *      declared file path.
 *   3. Caller-supplied project-kind values override bundle defaults.
 *   4. Missing required file-kind input → ok:false with an error naming
 *      the input id; project.json NOT written.
 *   5. Empty-string for required file-kind treated as missing → error.
 *   6. projectDir doesn't exist → ok:false (caller's responsibility to
 *      create the folder first).
 *   7. projectDir already contains project.json → ok:false, refuses
 *      overwrite.
 *   8. Unknown bundle id → ok:false.
 *   9. Bundle with no inputs[] → still writes project.json successfully.
 *  10. Nested project-kind field (dot-path) writes deep into project.json.
 *  11. Optional description recorded when provided.
 *  12. createdAt is an ISO string.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject } from '../../src/dag/initializeProject.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dhee-init-test-'));
}

describe('initializeProject', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('1. happy path: writes project.json + inputs/story.md with all values', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'My Cinematic Project',
      bundleId: 'narrative_prompt_relay',
      inputs: {
        story_input: 'A young engineer discovers a glitch.',
        targetDuration: 120,
        style: 'noir',
        aspect: '21:9',
      },
    });
    expect(result.ok).toBe(true);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.name).toBe('My Cinematic Project');
    expect(project.bundleSource).toBe('built-in:narrative_prompt_relay');
    expect(project.targetDuration).toBe(120);
    expect(project.style).toBe('noir');
    expect(project.aspect).toBe('21:9');
  });

  it('2. story content written verbatim to bundle.inputs[].path', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const story = 'A detective walks into the room. "You\'re late," she says.';
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_shot_by_shot',
      inputs: {
        story_input: story,
        targetDuration: 30,
        style: 'cinematic_realism',
        aspect: '16:9',
      },
    });
    expect(readFileSync(join(projectDir, 'inputs', 'story.md'), 'utf8')).toBe(story);
  });

  it('3. caller values override bundle defaults', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    // narrative_prompt_relay default targetDuration=60. Pass 180.
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a', targetDuration: 180 },
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.targetDuration).toBe(180);
  });

  it('3b. bundle defaults applied when caller omits project-kind value', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' }, // no duration/style/aspect
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.targetDuration).toBe(60);
    expect(project.style).toBe('cinematic_realism');
    expect(project.aspect).toBe('16:9');
  });

  it('4. missing required file-kind input → ok:false + project.json not written', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { targetDuration: 60 }, // story_input missing
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('story_input');
    }
    expect(existsSync(join(projectDir, 'project.json'))).toBe(false);
  });

  it('5. empty string for required file-kind → error', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: '' },
    });
    expect(result.ok).toBe(false);
  });

  it('6. projectDir does not exist → ok:false', () => {
    const result = initializeProject({
      projectDir: '/nonexistent/path/that/never/was',
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('does not exist');
    }
  });

  it('7. projectDir already has project.json → refuses overwrite', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    writeFileSync(join(projectDir, 'project.json'), '{}', 'utf8');
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('already exists');
    }
  });

  it('8. unknown bundle id → ok:false', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    const result = initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'nonexistent_bundle',
      inputs: { story_input: 'a' },
    });
    expect(result.ok).toBe(false);
  });

  it('11. optional description recorded when provided', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      description: 'A test thing',
      inputs: { story_input: 'a' },
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.description).toBe('A test thing');
  });

  it('12. createdAt is an ISO date string', () => {
    const projectDir = tmpDir();
    made.push(projectDir);
    initializeProject({
      projectDir,
      name: 'X',
      bundleId: 'narrative_prompt_relay',
      inputs: { story_input: 'a' },
    });
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(typeof project.createdAt).toBe('string');
    expect(new Date(project.createdAt as string).toISOString()).toBe(project.createdAt);
  });

  it('13. user bundleSource is persisted for user-installed bundles', () => {
    const bundlesDir = tmpDir();
    const projectDir = tmpDir();
    made.push(bundlesDir, projectDir);
    mkdirSync(join(bundlesDir, 'youtube_short_text_video'), { recursive: true });
    writeFileSync(
      join(bundlesDir, 'youtube_short_text_video', 'bundle.json'),
      JSON.stringify({
        id: 'youtube_short_text_video',
        version: '0.1.0',
        goal: 'final_video',
        inputs: [{ id: 'story_input', kind: 'file', path: 'inputs/story.md', required: true }],
        nodes: [
          {
            id: 'final_video',
            kind: 'stage',
            inputs: [],
            outputs: { format: 'video', pattern: 'final/out.mp4' },
            runner: { tool: 'ffmpeg.concat', config: {} },
          },
        ],
      }),
      'utf8'
    );

    const prev = process.env['DHEE_USER_BUNDLES_DIR'];
    process.env['DHEE_USER_BUNDLES_DIR'] = bundlesDir;
    try {
      const result = initializeProject({
        projectDir,
        name: 'YouTube Package Project',
        bundleId: 'youtube_short_text_video',
        bundleSource: 'user:youtube_short_text_video',
        inputs: { story_input: 'A creator finds a better way to tell a story.' },
      });
      expect(result.ok).toBe(true);
      const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
      expect(project.bundleSource).toBe('user:youtube_short_text_video');
      expect(readFileSync(join(projectDir, 'inputs', 'story.md'), 'utf8')).toBe(
        'A creator finds a better way to tell a story.'
      );
    } finally {
      if (prev === undefined) delete process.env['DHEE_USER_BUNDLES_DIR'];
      else process.env['DHEE_USER_BUNDLES_DIR'] = prev;
    }
  });
});
