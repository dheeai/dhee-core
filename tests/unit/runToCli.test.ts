/**
 * Tests for the `pnpm run-to` CLI argument parser.
 *
 * The parser is the only piece of `scripts/run-to.ts` that can be
 * behaviorally tested without spawning a real ExecutorAgent + LLM.
 * Executor behavior is covered by stageGate.test.ts + the existing
 * e2e helpers — this test just locks down the CLI contract:
 *   - Valid (project, stage, skipMedia) combos parse cleanly.
 *   - Unknown stage names throw (prevents silent typos).
 *   - --skip-media is a flag, not a positional.
 *   - Wrong arg count throws.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../scripts/run-to.js';

describe('run-to CLI — parseArgs', () => {
  it('parses project + stage + no flags', () => {
    expect(parseArgs(['lazarus_drive', 'character_image'])).toEqual({
      projectName: 'lazarus_drive',
      target: 'character_image',
      skipMedia: false,
    });
  });

  it('parses project alone (no target — drives to final_video)', () => {
    expect(parseArgs(['lazarus_drive'])).toEqual({
      projectName: 'lazarus_drive',
      target: null,
      skipMedia: false,
    });
  });

  it('picks up --skip-media as a flag, keeps positional order clean', () => {
    expect(parseArgs(['lazarus_drive', 'scene_video_prompt', '--skip-media'])).toEqual({
      projectName: 'lazarus_drive',
      target: 'scene_video_prompt',
      skipMedia: true,
    });
  });

  it('accepts -s as shorthand for --skip-media', () => {
    expect(parseArgs(['lazarus_drive', 'scene_video_prompt', '-s'])).toEqual({
      projectName: 'lazarus_drive',
      target: 'scene_video_prompt',
      skipMedia: true,
    });
  });

  it('accepts --skip-media with no target (run to final_video, LLM only)', () => {
    expect(parseArgs(['lazarus_drive', '--skip-media'])).toEqual({
      projectName: 'lazarus_drive',
      target: null,
      skipMedia: true,
    });
  });

  it('throws on unknown bare target (not a stage, no node-id-shape)', () => {
    expect(() => parseArgs(['lazarus_drive', 'totally_bogus']))
      .toThrow(/Unknown target/);
  });

  it('throws on no positional args', () => {
    expect(() => parseArgs([])).toThrow(/positional/);
  });

  it('throws on too many positional args', () => {
    expect(() => parseArgs(['lazarus_drive', 'character_image', 'extra_arg']))
      .toThrow(/positional/);
  });

  it('is case-sensitive on the stage (matches /reset + /run-to wire format)', () => {
    expect(() => parseArgs(['lazarus_drive', 'Character_Image']))
      .toThrow(/Unknown target/);
  });

  it('accepts every canonical stage from VALID_STAGES', async () => {
    const { VALID_STAGES } = await import('../../src/core/planner/stages.js');
    for (const stage of VALID_STAGES) {
      const parsed = parseArgs(['test_project', stage]);
      expect(parsed.target, `stage ${stage} should parse`).toBe(stage);
    }
  });

  it('flag position does not matter (prepended flag with two positional args)', () => {
    // A user might write `pnpm run-to --skip-media foo bar`. Accept it.
    expect(parseArgs(['--skip-media', 'lazarus_drive', 'character_image'])).toEqual({
      projectName: 'lazarus_drive',
      target: 'character_image',
      skipMedia: true,
    });
  });

  it('accepts a node-id target (typeId:itemId form) — final resolution deferred to main()', () => {
    // The parser only needs to recognize that this LOOKS like a node id
    // (contains a colon). main() then validates against executorState.
    expect(parseArgs(['lazarus_drive', 'shot_image:scene_1_shot_1'])).toEqual({
      projectName: 'lazarus_drive',
      target: 'shot_image:scene_1_shot_1',
      skipMedia: false,
    });
  });

  it('accepts a friendly-suffix alias (looks like a node alias) — final resolution deferred', () => {
    expect(parseArgs(['lazarus_drive', 'scene_1_shot_2.image'])).toEqual({
      projectName: 'lazarus_drive',
      target: 'scene_1_shot_2.image',
      skipMedia: false,
    });
  });
});

/**
 * Regression: `submitImageGeneration` in src/tasks/video/tools.ts reads the
 * active project via the global `getProjectDir()` (which reads the session
 * projectDir). Before the fix, the CLI bootstrap only put the project path
 * into ExecutorAgent's config but never called `setActiveProjectDir`, so
 * every media helper would fall back to `default.dhee` and images leaked
 * into the wrong folder — surfaces as "Base image not found" on the next
 * pipeline step that reads them from the correct project. The UI sets it
 * in App.tsx; the CLI must do the same.
 */
describe('run-to CLI — session projectDir scoping', () => {
  it('setActiveProjectDir routes getActiveProjectDir to the project folder', async () => {
    const { setActiveProjectDir, getActiveProjectDir } =
      await import('../../src/tasks/video/workflow/activeProject.js');
    setActiveProjectDir('noir_detective_story_setup-3.dhee');
    expect(getActiveProjectDir()).toBe('noir_detective_story_setup-3.dhee');
  });

  it('getProjectDir resolves session projectDir against cwd for relative names', async () => {
    const { setActiveProjectDir } =
      await import('../../src/tasks/video/workflow/activeProject.js');
    const { getProjectDir } =
      await import('../../src/tasks/video/workflow/ProjectManager.js');
    setActiveProjectDir('noir_detective_story_setup-3.dhee');
    expect(getProjectDir('/tmp/repo')).toBe('/tmp/repo/noir_detective_story_setup-3.dhee');
  });
});
