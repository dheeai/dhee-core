import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildShotMotionContext } from '../../../src/dag/runners/shotMotionContext.js';

describe('buildShotMotionContext', () => {
  it('reads previous motion for context without creating a tail-cascade dependency', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'shot-motion-context-'));
    mkdirSync(join(projectDir, 'prompts/shot_image'), { recursive: true });
    mkdirSync(join(projectDir, 'prompts/motion'), { recursive: true });

    for (const id of ['scene_1_shot_1', 'scene_1_shot_2', 'scene_1_shot_3']) {
      writeFileSync(
        join(projectDir, `prompts/shot_image/${id}.json`),
        JSON.stringify({ imagePrompt: `image prompt for ${id}` }),
      );
    }
    writeFileSync(
      join(projectDir, 'prompts/motion/scene_1_shot_1.json'),
      JSON.stringify({ description: 'previous motion', transition: 'cut to shot 2' }),
    );

    const result = buildShotMotionContext({
      projectDir,
      itemId: 'scene_1_shot_2',
      shots: [
        { id: 'scene_1_shot_1', scene: 1, shotNumber: 1 },
        { id: 'scene_1_shot_2', scene: 1, shotNumber: 2 },
        { id: 'scene_1_shot_3', scene: 1, shotNumber: 3 },
      ],
      imagePromptPattern: 'prompts/shot_image/{{item_id}}.json',
      motionDirectivePattern: 'prompts/motion/{{item_id}}.json',
    });

    expect(result.context.previousShot?.motionDirective?.description).toBe('previous motion');
    expect(result.additionalDependencies).toEqual([
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_1', role: 'context' },
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_2', role: 'context' },
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'context' },
    ]);
  });
});
