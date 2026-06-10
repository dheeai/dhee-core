import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveLtxDirectorConfigFromInputs,
  type LtxDirectorConfig,
} from '../../../src/dag/runners/comfyLtxDirector.js';
import type { RunnerContext } from '../../../src/dag/schema.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ltx-resolve-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(inputs: Record<string, unknown>): RunnerContext {
  return {
    projectDir,
    bundleDir: join(projectDir, 'bundle'),
    itemId: 'scene_1_chunk_1',
    node: {
      id: 'scene_clip',
      kind: 'collection',
      inputs: [],
      outputs: { format: 'video', pattern: 'out.mp4' },
      runner: { tool: 'comfy.ltx_director', config: {} },
    },
    inputs,
    log: () => {},
    llm: {
      async generateText() {
        return { text: '' };
      },
    },
  };
}

describe('comfy.ltx_director input resolution', () => {
  it('uses shot_motion_directive JSON as the local prompt source', () => {
    const first1 = join(projectDir, 'assets/images/scene_1_shot_1.png');
    const first2 = join(projectDir, 'assets/images/scene_1_shot_2.png');
    const motion1 = join(projectDir, 'prompts/motion/scene_1_shot_1.json');
    const scenePrompt = join(projectDir, 'prompts/videos/scenes/scene_1.md');
    mkdirSync(join(projectDir, 'assets/images'), { recursive: true });
    mkdirSync(join(projectDir, 'prompts/motion'), { recursive: true });
    mkdirSync(join(projectDir, 'prompts/videos/scenes'), { recursive: true });
    writeFileSync(first1, '');
    writeFileSync(first2, '');
    writeFileSync(scenePrompt, 'Cafe loop scene brief');
    writeFileSync(
      motion1,
      JSON.stringify({
        description: 'Alex slowly turns the cup while the camera pushes in.',
        cameraWork: 'medium close-up, controlled push-in',
        audio: 'Alex: Watch the clock.',
        purpose: 'Alex demonstrates the loop',
        transition: 'Cut to Jordan reacting across the table.',
      }),
    );

    const cfg: LtxDirectorConfig = {
      workflowPath: 'workflows/ltx_director_local.json',
      outputPath: 'clips/scene_1_chunk_1.mp4',
      sceneNumber: 1,
      shotRange: [1, 1],
    };
    const result = resolveLtxDirectorConfigFromInputs(
      makeCtx({
        scenes_plan: {
          shots: [
            {
              id: 'scene_1_shot_1',
              scene: 1,
              shotNumber: 1,
              duration: 4,
              description: 'Original scene-plan description',
              cameraWork: 'wide static',
              dialogue: 'Watch the clock.',
              speaker: 'alex',
            },
            {
              id: 'scene_1_shot_2',
              scene: 1,
              shotNumber: 2,
              duration: 4,
              description: 'Jordan reacts.',
              cameraWork: 'reverse close-up',
            },
          ],
        },
        shot_image: {
          scene_1_shot_1: first1,
          scene_1_shot_2: first2,
        },
        shot_motion_directive: {
          scene_1_shot_1: motion1,
        },
        scene_video_prompt: {
          scene_1: scenePrompt,
        },
      }),
      cfg,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cfg.shots).toHaveLength(1);
    expect(result.cfg.shots[0]?.description).toBe('Alex slowly turns the cup while the camera pushes in.');
    expect(result.cfg.shots[0]?.cameraWork).toBe('medium close-up, controlled push-in');
    expect(result.cfg.shots[0]?.transition).toBe('Cut to Jordan reacting across the table.');
    expect(result.cfg.globalPrompt).toBe('Cafe loop scene brief');
    expect(result.cfg.dependencies).toContainEqual({
      nodeId: 'shot_motion_directive',
      itemId: 'scene_1_shot_1',
      role: 'input',
    });
  });
});
