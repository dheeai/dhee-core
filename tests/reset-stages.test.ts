/**
 * Tests for the reset stage computation.
 * Verifies that resetting a stage correctly cascades to all downstream types
 * based on the dependency graph (not hardcoded lists).
 */
import { describe, it, expect } from 'vitest';
import { computeResetTypes, TEMPLATE_DEPS, STAGE_ALIASES } from '../scripts/reset-project.js';

describe('computeResetTypes', () => {
  it('reset plot cascades to everything', () => {
    const types = computeResetTypes('plot');
    // plot is the root — everything depends on it transitively
    expect(types).toContain('plot');
    expect(types).toContain('story');
    expect(types).toContain('character');
    expect(types).toContain('setting');
    expect(types).toContain('scene');
    expect(types).toContain('world_style');
    expect(types).toContain('character_image');
    expect(types).toContain('setting_image');
    expect(types).toContain('scene_video_prompt');
    expect(types).toContain('shot_image_prompt');
    expect(types).toContain('shot_motion_directive');
    expect(types).toContain('shot_image');
    expect(types).toContain('shot_video');
    expect(types).toContain('final_video');
  });

  it('reset scene_video_prompt includes shot_motion_directive', () => {
    const types = computeResetTypes('scene_video_prompt');
    expect(types).toContain('scene_video_prompt');
    expect(types).toContain('shot_image_prompt');
    expect(types).toContain('shot_motion_directive');
    expect(types).toContain('shot_image');
    expect(types).toContain('shot_video');
    expect(types).toContain('final_video');
    // Should NOT include upstream types
    expect(types).not.toContain('scene');
    expect(types).not.toContain('character');
    expect(types).not.toContain('story');
    expect(types).not.toContain('plot');
  });

  it('reset character cascades through character_image to shot_image and beyond', () => {
    const types = computeResetTypes('character');
    expect(types).toContain('character');
    expect(types).toContain('character_image');
    expect(types).toContain('scene'); // scene depends on character
    expect(types).toContain('scene_video_prompt'); // depends on scene + character_image
    expect(types).toContain('shot_motion_directive'); // depends on scene_video_prompt
    expect(types).toContain('shot_image'); // depends on character_image
    expect(types).toContain('shot_video');
    expect(types).toContain('final_video');
    // Should NOT include unrelated upstream
    expect(types).not.toContain('plot');
    expect(types).not.toContain('story');
  });

  it('reset shot_video only resets shot_video and final_video', () => {
    const types = computeResetTypes('shot_video');
    expect(types).toEqual(expect.arrayContaining(['shot_video', 'final_video']));
    expect(types).toHaveLength(2);
  });

  it('reset final_video only resets itself', () => {
    const types = computeResetTypes('final_video');
    expect(types).toEqual(['final_video']);
  });

  it('reset world_style cascades to scene_video_prompt and downstream', () => {
    const types = computeResetTypes('world_style');
    expect(types).toContain('world_style');
    expect(types).toContain('scene_video_prompt');
    expect(types).toContain('shot_motion_directive');
    expect(types).toContain('shot_image_prompt');
    expect(types).toContain('shot_image');
    expect(types).toContain('shot_video');
    expect(types).toContain('final_video');
    // Should NOT include character/setting/scene (they don't depend on world_style)
    expect(types).not.toContain('character');
    expect(types).not.toContain('setting');
    expect(types).not.toContain('scene');
  });

  it('reset shot_image_prompt cascades to shot_motion_directive and downstream', () => {
    // shot_motion_directive depends on shot_image_prompt (among others)
    const types = computeResetTypes('shot_image_prompt');
    expect(types).toContain('shot_image_prompt');
    expect(types).toContain('shot_motion_directive');
    expect(types).toContain('shot_image');
    expect(types).toContain('shot_video');
    expect(types).toContain('final_video');
  });

  it('reset setting cascades through setting_image', () => {
    const types = computeResetTypes('setting');
    expect(types).toContain('setting');
    expect(types).toContain('setting_image');
    expect(types).toContain('scene'); // scene depends on setting
    expect(types).toContain('world_style'); // world_style depends on setting
    expect(types).toContain('scene_video_prompt');
    expect(types).toContain('shot_motion_directive');
    expect(types).not.toContain('character');
    expect(types).not.toContain('plot');
  });

  it('all types in TEMPLATE_DEPS are reachable from plot', () => {
    const fromPlot = computeResetTypes('plot');
    for (const type of Object.keys(TEMPLATE_DEPS)) {
      expect(fromPlot).toContain(type);
    }
  });
});

describe('reset preserves files on disk', () => {
  const { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } = require('fs');
  const { join } = require('path');
  const { execSync } = require('child_process');
  const { tmpdir } = require('os');

  function createTempProject(): string {
    const name = `reset-test-${Date.now()}`;
    const dir = join(process.cwd(), `${name}.dhee`);
    mkdirSync(join(dir, 'assets', 'videos', 'shots'), { recursive: true });
    mkdirSync(join(dir, 'assets', 'videos', 'final'), { recursive: true });
    mkdirSync(join(dir, 'assets', 'images'), { recursive: true });

    // Create fake output files
    writeFileSync(join(dir, 'assets', 'videos', 'final', 'final_video.mp4'), 'fake-video');
    writeFileSync(join(dir, 'assets', 'videos', 'shots', 'scene_1_shot_1.mp4'), 'fake-shot');
    writeFileSync(join(dir, 'assets', 'images', 'char.png'), 'fake-image');

    // Create project.json with executor state
    const project = {
      executorState: {
        nodes: {
          'final_video': {
            id: 'final_video',
            typeId: 'final_video',
            status: 'completed',
            displayName: 'Final Video',
            isExpensive: true,
            isCollection: false,
            dependencies: ['shot_video:scene_1_shot_1'],
            dependents: [],
            outputPath: 'assets/videos/final/final_video.mp4',
            completedAt: Date.now(),
          },
          'shot_video:scene_1_shot_1': {
            id: 'shot_video:scene_1_shot_1',
            typeId: 'shot_video',
            itemId: 'scene_1_shot_1',
            status: 'completed',
            displayName: 'Shot Video S1S1',
            isExpensive: true,
            isCollection: false,
            dependencies: [],
            dependents: ['final_video'],
            outputPath: 'assets/videos/shots/scene_1_shot_1.mp4',
            completedAt: Date.now(),
          },
        },
        targetArtifacts: ['final_video'],
      },
    };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));

    return name;
  }

  it('reset final_video preserves video files on disk', () => {
    const name = createTempProject();
    const dir = join(process.cwd(), `${name}.dhee`);

    try {
      const tsxPath = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const scriptPath = join(process.cwd(), 'scripts', 'reset-project.ts');
      execSync(`"${tsxPath}" "${scriptPath}" "${name}" "final_video"`, {
        cwd: process.cwd(), encoding: 'utf-8', timeout: 15000,
      });

      // Files must still exist
      expect(existsSync(join(dir, 'assets', 'videos', 'final', 'final_video.mp4'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'videos', 'shots', 'scene_1_shot_1.mp4'))).toBe(true);

      // Node state must be reset
      const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
      expect(project.executorState.nodes['final_video'].status).toBe('pending');
      expect(project.executorState.nodes['final_video'].outputPath).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reset shot_video preserves shot video files and images on disk', () => {
    const name = createTempProject();
    const dir = join(process.cwd(), `${name}.dhee`);

    try {
      const tsxPath = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const scriptPath = join(process.cwd(), 'scripts', 'reset-project.ts');
      execSync(`"${tsxPath}" "${scriptPath}" "${name}" "shot_video"`, {
        cwd: process.cwd(), encoding: 'utf-8', timeout: 15000,
      });

      // All files must still exist
      expect(existsSync(join(dir, 'assets', 'videos', 'final', 'final_video.mp4'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'videos', 'shots', 'scene_1_shot_1.mp4'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'images', 'char.png'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('STAGE_ALIASES sibling resets', () => {
  /** Helper: resolve alias and compute full reset set (mirrors main() logic) */
  function resolveAlias(stage: string): string[] {
    const aliasValue = STAGE_ALIASES[stage];
    if (!aliasValue) return [];
    const startTypes = Array.isArray(aliasValue) ? aliasValue : [aliasValue];
    return [...new Set(startTypes.flatMap(t => computeResetTypes(t)))];
  }

  it('character_image alias resets both character_image and setting_image', () => {
    const types = resolveAlias('character_image');
    expect(types).toContain('character_image');
    expect(types).toContain('setting_image');
    expect(types).toContain('shot_image');
    expect(types).toContain('shot_video');
    expect(types).toContain('final_video');
    // scene_video_prompt does NOT depend on character_image or setting_image
    expect(types).not.toContain('scene_video_prompt');
    // Should NOT include upstream content types
    expect(types).not.toContain('character');
    expect(types).not.toContain('setting');
    expect(types).not.toContain('world_style');
    expect(types).not.toContain('story');
  });

  it('characters alias resets character + setting and all downstream', () => {
    const types = resolveAlias('characters');
    expect(types).toContain('character');
    expect(types).toContain('setting');
    expect(types).toContain('character_image');
    expect(types).toContain('setting_image');
    expect(types).toContain('scene');
    expect(types).toContain('world_style');
    expect(types).toContain('scene_video_prompt');
    expect(types).toContain('shot_motion_directive');
    expect(types).toContain('final_video');
    expect(types).not.toContain('story');
    expect(types).not.toContain('plot');
  });

  it('single-type alias works normally', () => {
    const types = resolveAlias('shot_video');
    expect(types).toEqual(expect.arrayContaining(['shot_video', 'final_video']));
    expect(types).toHaveLength(2);
  });

  it('world_style cascades to character_image and setting_image', () => {
    const types = resolveAlias('world_style');
    expect(types).toContain('world_style');
    expect(types).toContain('character_image');
    expect(types).toContain('setting_image');
  });
});
