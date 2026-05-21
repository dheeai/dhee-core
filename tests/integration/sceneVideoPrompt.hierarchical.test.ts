/**
 * Integration test for the hierarchical scene_video_prompt flow.
 *
 * Exercises the contract that the executor wires up at runtime:
 *
 *   scene_shot_plan (Stage A LLM) → .plan.json on disk
 *   shot_breakdown  (Stage B LLM, per shot) → .shots/N.json on disk
 *   scene_video_prompt (Stage C deterministic) → reads both above,
 *     calls assembleSceneVideoPrompt(), runs the same post-validators
 *     the legacy single-call path ran, writes the canonical
 *     prompts/videos/scenes/{scene}.json that downstream consumers
 *     (shot_image_prompt builder, shot_motion_directive, the SceneBundle
 *     renderer) read today.
 *
 * The test sets the per-stage files up on disk against the REAL narrative
 * template, then drives the assembly path directly (no LLM client) to
 * prove:
 *   1. The graph topology cascades correctly when scene is expanded.
 *   2. The on-disk path conventions resolve to where the
 *      executor expects them.
 *   3. The assembled JSON satisfies sceneVideoPromptSchema (the
 *      consumer-facing contract).
 *   4. The shape matches what the shot_image_prompt builder reads
 *      (shots[].shotNumber, .purpose, .description, .cameraWork,
 *      .perspective, .focus, .audio, .transition, ...).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import { narrativeTemplate } from '../../src/templates/narrative.js';
import { assembleSceneVideoPrompt } from '../../src/core/planner/sceneVideoPromptAssembler.js';
import {
  sceneVideoPromptSchema,
  shotPlanSchema,
  singleShotSchema,
  validateWithSchema,
} from '../../src/core/planner/schemas.js';
import { getOutputPath } from '../../src/core/planner/contentResolver.js';
import type { AssetRegistry, ExecutionNode } from '../../src/core/planner/types.js';

let projectDir: string;

beforeAll(() => {
  projectDir = join(tmpdir(), `kshana-hierarchical-int-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });
});

afterAll(() => {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

// Fixtures shaped like what real LLMs would emit at each stage.
const stageAPlan = {
  sceneNumber: 2,
  sceneTitle: "Arrival at the Singh House",
  totalDuration: 13,
  mainSubject: "parvati",
  secondarySubject: "mrs._singh",
  entry: "Parvati steps off the bus, dust settling.",
  exit: "Parvati closes the bungalow gate behind her.",
  shotPlan: [
    {
      shotNumber: 1,
      purpose: "meet_character" as const,
      duration: 4,
      oneLineSummary: "Parvati walks the last stretch of road to the Singh bungalow.",
      perspective: "main_subject" as const,
      continuityRole: "entry" as const,
    },
    {
      shotNumber: 2,
      purpose: "show_action" as const,
      duration: 3,
      oneLineSummary: "She pushes open the servant's door, kitchen smells hit.",
      perspective: "main_subject" as const,
    },
    {
      shotNumber: 3,
      purpose: "show_dialogue" as const,
      duration: 6,
      oneLineSummary: "Mrs. Singh greets her without looking up.",
      perspective: "secondary_subject" as const,
    },
  ],
};

const stageBShot1 = {
  shotNumber: 1,
  purpose: "meet_character" as const,
  duration: 4,
  description: "Parvati walks the last stretch of road to the Singh bungalow, dust rising with each step.",
  cameraWork: "medium, slight low angle, tracking left to right as she walks",
  perspective: "main_subject" as const,
  perspectiveOf: "parvati",
  focus: { primary: "parvati", background: ["singh_bungalow"], lurking: null },
  continuityRole: "entry" as const,
  audio: "footsteps on gravel, distant cicada hum, wind",
  transition: "fade",
};

const stageBShot2 = {
  shotNumber: 2,
  purpose: "show_action" as const,
  duration: 3,
  description: "Parvati pushes open the blue peeling servant's door and steps into the kitchen.",
  cameraWork: "close-up on hand pushing door, then pull back to medium shot, shallow DOF",
  perspective: "main_subject" as const,
  focus: { primary: "parvati_face", background: ["kitchen_stove", "steel_counters"] },
  continuityRole: "entry" as const,
  audio: "door creak, sizzle of frying, overhead fan drone",
  transition: "cut",
};

const stageBShot3 = {
  shotNumber: 3,
  purpose: "show_dialogue" as const,
  duration: 6,
  description: "Mrs. Singh sits at the polished teak table, bone china teacup in hand.",
  cameraWork: "medium shot from side, slightly high angle, static",
  perspective: "secondary_subject" as const,
  focus: { primary: "mrs._singh", background: ["teak_table", "teacup"] },
  continuityRole: "none" as const,
  audio: "MRS. SINGH: You're late, Parvati. Newspaper rustle, teacup clink.",
  transition: "cut",
};

describe('hierarchical scene_video_prompt — graph topology', () => {
  it('expanding scene cascades to scene_shot_plan, shot_breakdown (collection), and scene_video_prompt per-item nodes', () => {
    const planner = new BackwardPlanner(narrativeTemplate);
    const registry: AssetRegistry = { assets: new Map(), satisfiedArtifacts: new Map(), lastScanAt: Date.now() };
    const plan = planner.buildPlan(
      { targetArtifacts: ['final_video'], preferences: {}, description: 'test' },
      registry,
    );
    const executor = DependencyGraphExecutor.fromPlan(plan, narrativeTemplate);
    executor.markCompleted('plot');
    executor.markCompleted('story');
    executor.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Scene 1' },
      { itemId: 'scene_2', name: 'Scene 2' },
    ]);

    // Stage A nodes exist with scene as their direct dep
    expect(executor.getNode('scene_shot_plan:scene_1')).toBeDefined();
    expect(executor.getNode('scene_shot_plan:scene_2')).toBeDefined();
    expect(executor.getNode('scene_shot_plan:scene_1')?.dependencies).toContain('scene:scene_1');

    // Stage B parent collection nodes exist (will be expanded to per-shot
    // later, after Stage A produces .plan.json at runtime)
    expect(executor.getNode('shot_breakdown:scene_1')).toBeDefined();
    expect(executor.getNode('shot_breakdown:scene_1')?.isCollection).toBe(true);

    // Stage C nodes exist and depend on both Stage A and the Stage B parent
    const svp1 = executor.getNode('scene_video_prompt:scene_1');
    expect(svp1).toBeDefined();
    expect(svp1?.dependencies).toContain('scene_shot_plan:scene_1');
    expect(svp1?.dependencies).toContain('shot_breakdown:scene_1');

    // The legacy direct scene → scene_video_prompt edge is GONE
    expect(svp1?.dependencies).not.toContain('scene:scene_1');
    expect(svp1?.dependencies).not.toContain('scene');
  });

  it('downstream shot_image_prompt still depends on the (now-deterministic) scene_video_prompt', () => {
    // The whole point of the refactor is that downstream consumers don't
    // notice anything different — they still read scene_video_prompt's
    // assembled JSON at the same path.
    const planner = new BackwardPlanner(narrativeTemplate);
    const registry: AssetRegistry = { assets: new Map(), satisfiedArtifacts: new Map(), lastScanAt: Date.now() };
    const plan = planner.buildPlan(
      { targetArtifacts: ['final_video'], preferences: {}, description: 'test' },
      registry,
    );
    const executor = DependencyGraphExecutor.fromPlan(plan, narrativeTemplate);
    executor.markCompleted('plot');
    executor.markCompleted('story');
    executor.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);

    const shotImagePrompt = executor.getNode('shot_image_prompt:scene_1');
    expect(shotImagePrompt).toBeDefined();
    expect(shotImagePrompt?.dependencies).toContain('scene_video_prompt:scene_1');
  });

  it('STAGE_ALIASES.scene_video_prompt spans the three layers so /reset clears them all', async () => {
    const { STAGE_ALIASES } = await import('../../src/core/planner/stages.js');
    const alias = STAGE_ALIASES.scene_video_prompt!;
    expect(alias).toContain('scene_shot_plan');
    expect(alias).toContain('shot_breakdown');
    expect(alias).toContain('scene_video_prompt');
  });
});

describe('hierarchical scene_video_prompt — disk path contract', () => {
  it('scene_shot_plan writes to {scene}.plan.json next to the final scene JSON', () => {
    const node: ExecutionNode = {
      id: 'scene_shot_plan:scene_1',
      typeId: 'scene_shot_plan',
      itemId: 'scene_1',
      status: 'pending',
      displayName: 'Scene Shot Plan: Scene 1',
      isExpensive: false,
      isCollection: false,
      dependencies: [],
      dependents: [],
    };
    const path = getOutputPath(node, projectDir, narrativeTemplate);
    expect(path).toBe('prompts/videos/scenes/scene_1.plan.json');
  });

  it('shot_breakdown writes under a per-scene subdir keyed by shot number', () => {
    const node: ExecutionNode = {
      id: 'shot_breakdown:scene_1_shot_3',
      typeId: 'shot_breakdown',
      itemId: 'scene_1_shot_3',
      status: 'pending',
      displayName: 'Shot Breakdown: scene_1 shot 3',
      isExpensive: false,
      isCollection: false,
      dependencies: [],
      dependents: [],
    };
    const path = getOutputPath(node, projectDir, narrativeTemplate);
    expect(path).toBe('prompts/videos/scenes/scene_1.shots/3.json');
  });

  it('scene_video_prompt keeps its existing path — same place consumers read today', () => {
    const node: ExecutionNode = {
      id: 'scene_video_prompt:scene_1',
      typeId: 'scene_video_prompt',
      itemId: 'scene_1',
      status: 'pending',
      displayName: 'Scene Breakdown: Scene 1',
      isExpensive: false,
      isCollection: false,
      dependencies: [],
      dependents: [],
    };
    const path = getOutputPath(node, projectDir, narrativeTemplate);
    expect(path).toBe('prompts/videos/scenes/scene_1.json');
  });
});

describe('hierarchical scene_video_prompt — assembly end-to-end (no LLM)', () => {
  it('plan + per-shot stubs assemble into a sceneVideoPromptSchema-shaped JSON', () => {
    // Persist the Stage A + B stubs to the canonical paths the executor
    // would use at runtime, just to prove the round trip works.
    const scenesDir = join(projectDir, 'prompts/videos/scenes');
    mkdirSync(scenesDir, { recursive: true });
    const shotsDir = join(scenesDir, 'scene_2.shots');
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(join(scenesDir, 'scene_2.plan.json'), JSON.stringify(stageAPlan, null, 2));
    writeFileSync(join(shotsDir, '1.json'), JSON.stringify(stageBShot1, null, 2));
    writeFileSync(join(shotsDir, '2.json'), JSON.stringify(stageBShot2, null, 2));
    writeFileSync(join(shotsDir, '3.json'), JSON.stringify(stageBShot3, null, 2));

    // Read back through the schemas exactly as the executor's assembly
    // helper does — the contract under test is "what's on disk fully
    // satisfies the parse + stitch contract."
    const planRaw = JSON.parse(readFileSync(join(scenesDir, 'scene_2.plan.json'), 'utf-8'));
    const planParsed = shotPlanSchema.parse(planRaw);
    const shot1Parsed = singleShotSchema.parse(JSON.parse(readFileSync(join(shotsDir, '1.json'), 'utf-8')));
    const shot2Parsed = singleShotSchema.parse(JSON.parse(readFileSync(join(shotsDir, '2.json'), 'utf-8')));
    const shot3Parsed = singleShotSchema.parse(JSON.parse(readFileSync(join(shotsDir, '3.json'), 'utf-8')));

    const assembled = assembleSceneVideoPrompt(planParsed, [shot1Parsed, shot2Parsed, shot3Parsed]);

    // 1. Schema-level: matches the consumer-facing contract.
    const validation = sceneVideoPromptSchema.safeParse(assembled);
    expect(validation.success).toBe(true);

    // 2. Round-trip through validateWithSchema (the executor's runtime check).
    const runtimeValidation = validateWithSchema('scene_video_prompt', assembled);
    expect(runtimeValidation.valid).toBe(true);

    // 3. Stable, sorted, complete.
    expect(assembled.shots.map(s => s.shotNumber)).toEqual([1, 2, 3]);
    expect(assembled.mainSubject).toBe('parvati');
    expect(assembled.secondarySubject).toBe('mrs._singh');
    expect(assembled.sceneTitle).toBe('Arrival at the Singh House');
  });

  it('assembled shape matches what the shot_image_prompt builder reads — shots[].shotNumber, .purpose, .description, .cameraWork, .perspective, .focus, .audio, .transition', () => {
    // Locks in the contract called out at ExecutorAgent.ts:3290-3346
    // (the per-shot context builder for shot_image_prompt). Any field
    // that block reads MUST be present on every shot in the assembled
    // output, or downstream silently degrades.
    const assembled = assembleSceneVideoPrompt(
      stageAPlan,
      [stageBShot1, stageBShot2, stageBShot3],
    );
    for (const shot of assembled.shots) {
      expect(typeof shot.shotNumber).toBe('number');
      expect(typeof shot.purpose).toBe('string');
      expect(typeof shot.description).toBe('string');
      expect(typeof shot.cameraWork).toBe('string');
      expect(typeof shot.perspective).toBe('string');
      expect(shot.focus).toBeDefined();
      expect(typeof shot.focus?.primary).toBe('string');
      expect(typeof shot.audio).toBe('string');
      expect(typeof shot.transition).toBe('string');
    }
  });

  it('rejects assembly when a planned shot is missing from the Stage B inputs (the failure-isolation contract)', () => {
    // Direct end-to-end check that a single missing per-shot file
    // surfaces clearly. In production this means the scene_video_prompt
    // node simply waits — its shot_breakdown dep is still pending. The
    // assembler itself MUST refuse to silently emit a partial scene.
    expect(() => assembleSceneVideoPrompt(stageAPlan, [stageBShot1, stageBShot2])).toThrow(
      /plan lists shotNumber 3 but no matching shot output/,
    );
  });

  it('rejects assembly when a Stage B output has a shot number not in the plan', () => {
    const orphanShot = { ...stageBShot1, shotNumber: 99 };
    expect(() =>
      assembleSceneVideoPrompt(stageAPlan, [stageBShot1, stageBShot2, stageBShot3, orphanShot]),
    ).toThrow(/shotNumber 99 but the plan does not list it/);
  });

  it('Stage B per-shot writes are independent — one shot can be regenerated without rewriting siblings', () => {
    // Crash-recovery / failure-isolation: the runtime invariant is that
    // each shot's .shots/N.json is independently writable / readable.
    // Verify by overwriting just shot 2 with a different camera and
    // confirming the assembled output picks up only that change.
    const scenesDir = join(projectDir, 'prompts/videos/scenes');
    const shotsDir = join(scenesDir, 'scene_2.shots');
    const updatedShot2 = { ...stageBShot2, cameraWork: 'overhead birds-eye, static' };
    writeFileSync(join(shotsDir, '2.json'), JSON.stringify(updatedShot2, null, 2));

    const planRaw = shotPlanSchema.parse(JSON.parse(readFileSync(join(scenesDir, 'scene_2.plan.json'), 'utf-8')));
    const shot1Parsed = singleShotSchema.parse(JSON.parse(readFileSync(join(shotsDir, '1.json'), 'utf-8')));
    const shot2Parsed = singleShotSchema.parse(JSON.parse(readFileSync(join(shotsDir, '2.json'), 'utf-8')));
    const shot3Parsed = singleShotSchema.parse(JSON.parse(readFileSync(join(shotsDir, '3.json'), 'utf-8')));

    const assembled = assembleSceneVideoPrompt(planRaw, [shot1Parsed, shot2Parsed, shot3Parsed]);
    const shot2InAssembly = assembled.shots.find(s => s.shotNumber === 2);
    expect(shot2InAssembly?.cameraWork).toBe('overhead birds-eye, static');
    // Shot 1 and 3 unchanged.
    expect(assembled.shots.find(s => s.shotNumber === 1)?.cameraWork).toBe(stageBShot1.cameraWork);
    expect(assembled.shots.find(s => s.shotNumber === 3)?.cameraWork).toBe(stageBShot3.cameraWork);
  });
});
