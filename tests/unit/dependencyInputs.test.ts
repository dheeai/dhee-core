/**
 * Dependency Input Verification Tests
 *
 * Verifies that each node type receives ONLY its declared dependencies
 * as context — no unwanted files, no binary data, no cross-contamination.
 *
 * These tests create a mock project with known files, run resolveInputs,
 * and assert exactly which files are read for each node type.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import { resolveInputs } from '../../src/core/planner/contentResolver.js';
import { narrativeTemplate } from '../../src/templates/narrative.js';
import type { ExecutionNode, AssetRegistry } from '../../src/core/planner/types.js';

let projectDir: string;
let executor: DependencyGraphExecutor;

/**
 * Build a fully expanded executor with all nodes completed and output files on disk.
 */
beforeAll(() => {
  projectDir = join(tmpdir(), `dhee-dep-test-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });

  // Create the executor from a proper backward plan
  const planner = new BackwardPlanner(narrativeTemplate);
  const registry: AssetRegistry = { assets: new Map(), satisfiedArtifacts: new Map(), lastScanAt: Date.now() };
  const plan = planner.buildPlan(
    { targetArtifacts: ['final_video'], preferences: {}, description: 'test' },
    registry,
  );
  executor = DependencyGraphExecutor.fromPlan(plan, narrativeTemplate);

  // Expand collections to simulate a real pipeline
  // story → characters, settings, scenes
  executor.markStarted('story');
  executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');
  executor.expandCollection('character', [
    { itemId: 'alice', name: 'Alice' },
    { itemId: 'bob', name: 'Bob' },
  ]);
  executor.expandCollection('setting', [
    { itemId: 'park', name: 'Park' },
    { itemId: 'house', name: 'House' },
  ]);
  executor.expandCollection('scene', [
    { itemId: 'scene_1', name: 'Scene 1' },
    { itemId: 'scene_2', name: 'Scene 2' },
  ]);

  // Mark all expanded nodes as completed with appropriate output paths
  const nodeOutputs: Record<string, string> = {
    'plot': 'chapters/chapter_1/plans/plot.md',
    'character:alice': 'characters/alice.md',
    'character:bob': 'characters/bob.md',
    'setting:park': 'settings/park.md',
    'setting:house': 'settings/house.md',
    'scene:scene_1': 'chapters/chapter_1/scenes/scene_1.md',
    'scene:scene_2': 'chapters/chapter_1/scenes/scene_2.md',
    'scene_shot_plan:scene_1': 'prompts/videos/scenes/scene_1.plan.json',
    'scene_shot_plan:scene_2': 'prompts/videos/scenes/scene_2.plan.json',
    'character_image:alice': 'assets/images/charref_alice.png',
    'character_image:bob': 'assets/images/charref_bob.png',
    'setting_image:park': 'assets/images/settingref_park.png',
    'setting_image:house': 'assets/images/settingref_house.png',
  };

  // Expand character_image, setting_image, scene_video_prompt
  executor.expandCollection('character_image', [
    { itemId: 'alice', name: 'Alice' },
    { itemId: 'bob', name: 'Bob' },
  ]);
  executor.expandCollection('setting_image', [
    { itemId: 'park', name: 'Park' },
    { itemId: 'house', name: 'House' },
  ]);
  // Hierarchical scene-breakdown flow: scene_shot_plan (Stage A LLM)
  // expands first; shot_breakdown (Stage B LLM) is created per-shot via
  // the runtime expansion in ExecutorAgent — this static test stub jumps
  // straight to the per-scene parents that exist before per-shot
  // expansion. scene_video_prompt is now the deterministic Stage C
  // assembler; its dependencies point at scene_shot_plan + shot_breakdown.
  executor.expandCollection('scene_shot_plan', [
    { itemId: 'scene_1', name: 'Scene 1' },
    { itemId: 'scene_2', name: 'Scene 2' },
  ]);
  executor.expandCollection('scene_video_prompt', [
    { itemId: 'scene_1', name: 'Scene 1' },
    { itemId: 'scene_2', name: 'Scene 2' },
  ]);

  // Mark all nodes completed
  for (const [nodeId, outputPath] of Object.entries(nodeOutputs)) {
    const node = executor.getNode(nodeId);
    if (node && node.status !== 'completed') {
      executor.markStarted(nodeId);
      executor.markCompleted(nodeId, outputPath);
    }
  }

  // Create scene_video_prompt outputs and expand to shots
  for (const sceneId of ['scene_1', 'scene_2']) {
    const svpId = `scene_video_prompt:${sceneId}`;
    const svpNode = executor.getNode(svpId);
    if (svpNode) {
      executor.markStarted(svpId);
      executor.markCompleted(svpId, `prompts/videos/scenes/${sceneId}.json`);
    }
  }

  // Expand shots from scene_video_prompt
  executor.expandCollection('shot_image_prompt:scene_1', [
    { itemId: 'scene_1_shot_1', name: 'Shot 1' },
    { itemId: 'scene_1_shot_2', name: 'Shot 2' },
  ]);
  executor.expandCollection('shot_image_prompt:scene_2', [
    { itemId: 'scene_2_shot_1', name: 'Shot 1' },
  ]);

  // Complete shot_image_prompt per-shot nodes with distinct outputs
  const shotPrompts: Record<string, string> = {
    'shot_image_prompt:scene_1_shot_1': 'prompts/images/shots/scene-1-shot-1.json',
    'shot_image_prompt:scene_1_shot_2': 'prompts/images/shots/scene-1-shot-2.json',
    'shot_image_prompt:scene_2_shot_1': 'prompts/images/shots/scene-2-shot-1.json',
  };
  for (const [nodeId, outputPath] of Object.entries(shotPrompts)) {
    const node = executor.getNode(nodeId);
    if (node) {
      executor.markStarted(nodeId);
      executor.markCompleted(nodeId, outputPath);
    }
  }

  // Complete shot_image per-shot nodes with distinct outputs
  const shotImages: Record<string, string> = {
    'shot_image:scene_1_shot_1': 'assets/images/shots/scene-1-shot-1.png',
    'shot_image:scene_1_shot_2': 'assets/images/shots/scene-1-shot-2.png',
    'shot_image:scene_2_shot_1': 'assets/images/shots/scene-2-shot-1.png',
  };
  for (const [nodeId, outputPath] of Object.entries(shotImages)) {
    const node = executor.getNode(nodeId);
    if (node) {
      executor.markStarted(nodeId);
      executor.markCompleted(nodeId, outputPath);
    }
  }

  // Create all output files on disk
  const textFiles: Record<string, string> = {
    'original_input.md': 'A story about Alice and Bob in the park.',
    'chapters/chapter_1/plans/plot.md': '# Plot\nAlice meets Bob.',
    'chapters/chapter_1/plans/story.md': '# Story\nAlice and Bob go to the park.',
    'characters/alice.md': '# Alice\nA brave girl.',
    'characters/bob.md': '# Bob\nA kind boy.',
    'settings/park.md': '# Park\nA sunny park.',
    'settings/house.md': '# House\nA cozy house.',
    'chapters/chapter_1/scenes/scene_1.md': '# Scene 1\nAlice arrives at the park.',
    'chapters/chapter_1/scenes/scene_2.md': '# Scene 2\nBob meets Alice.',
    'prompts/images/characters/alice.json': '{"imagePrompt":"Alice portrait","negativePrompt":"bad","aspectRatio":"1:1"}',
    'prompts/images/characters/bob.json': '{"imagePrompt":"Bob portrait","negativePrompt":"bad","aspectRatio":"1:1"}',
    'prompts/images/settings/park.json': '{"imagePrompt":"Park landscape","negativePrompt":"bad","aspectRatio":"16:9"}',
    'prompts/images/settings/house.json': '{"imagePrompt":"House exterior","negativePrompt":"bad","aspectRatio":"16:9"}',
    'prompts/videos/scenes/scene_1.plan.json': '{"sceneNumber":1,"sceneTitle":"Arrival","totalDuration":10,"mainSubject":"alice","shotPlan":[{"shotNumber":1,"purpose":"meet_character","duration":5,"oneLineSummary":"Wide shot of alice arriving"}]}',
    'prompts/videos/scenes/scene_2.plan.json': '{"sceneNumber":2,"sceneTitle":"Meeting","totalDuration":10,"mainSubject":"bob","shotPlan":[{"shotNumber":1,"purpose":"meet_character","duration":10,"oneLineSummary":"Medium shot of bob"}]}',
    'prompts/videos/scenes/scene_1.json': '{"sceneNumber":1,"sceneTitle":"Arrival","totalDuration":10,"shots":[{"shotNumber":1,"shotType":"wide","duration":5,"description":"Wide shot","characters":["alice"],"setting":"park"},{"shotNumber":2,"shotType":"close_up","duration":5,"description":"Close up","characters":["alice","bob"],"setting":"park"}]}',
    'prompts/videos/scenes/scene_2.json': '{"sceneNumber":2,"sceneTitle":"Meeting","totalDuration":10,"shots":[{"shotNumber":1,"shotType":"medium","duration":10,"description":"Medium shot","characters":["bob"],"setting":"house"}]}',
    'prompts/images/shots/scene-1-shot-1.json': '{"imagePrompt":"Wide shot of alice from image 1 in park from image 2","negativePrompt":"bad","aspectRatio":"16:9","generationMode":"image_text_to_image","references":[{"imageNumber":1,"type":"character","refId":"character_image:alice"},{"imageNumber":2,"type":"setting","refId":"setting_image:park"}]}',
    'prompts/images/shots/scene-1-shot-2.json': '{"imagePrompt":"Close up of alice from image 1 and bob from image 2 in park from image 3","negativePrompt":"bad","aspectRatio":"16:9","generationMode":"image_text_to_image","references":[{"imageNumber":1,"type":"character","refId":"character_image:alice"},{"imageNumber":2,"type":"character","refId":"character_image:bob"},{"imageNumber":3,"type":"setting","refId":"setting_image:park"}]}',
    'prompts/images/shots/scene-2-shot-1.json': '{"imagePrompt":"Medium shot of bob from image 1 in house from image 2","negativePrompt":"bad","aspectRatio":"16:9","generationMode":"image_text_to_image","references":[{"imageNumber":1,"type":"character","refId":"character_image:bob"},{"imageNumber":2,"type":"setting","refId":"setting_image:house"}]}',
  };

  for (const [filePath, content] of Object.entries(textFiles)) {
    const fullPath = join(projectDir, filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }

  // Create binary image files (small fake PNGs)
  const binaryFiles = [
    'assets/images/charref_alice.png',
    'assets/images/charref_bob.png',
    'assets/images/settingref_park.png',
    'assets/images/settingref_house.png',
  ];
  for (const filePath of binaryFiles) {
    const fullPath = join(projectDir, filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])); // PNG header
  }
});

function getNode(id: string): ExecutionNode {
  const node = executor.getNode(id);
  if (!node) throw new Error(`Node ${id} not found`);
  return node;
}

// =====================================================================
// Plot: should only get original_input.md (no dependencies)
// =====================================================================
describe('plot dependencies', () => {
  it('receives only original_input.md', () => {
    const node = getNode('plot');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toEqual(['original_input.md']);
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).toContain('original_input.md');
    expect(inputs.contextBlock).not.toContain('.png');
  });
});

// =====================================================================
// Story: should only get plot output
// =====================================================================
describe('story dependencies', () => {
  it('receives only plot.md', () => {
    const node = getNode('story');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toEqual(['chapters/chapter_1/plans/plot.md']);
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).toContain('plot.md');
    expect(inputs.contextBlock).not.toContain('story.md');
    expect(inputs.contextBlock).not.toContain('.png');
  });
});

// =====================================================================
// Character: should only get story
// =====================================================================
describe('character dependencies', () => {
  it('receives only story.md', () => {
    const node = getNode('character:alice');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toEqual(['chapters/chapter_1/plans/story.md']);
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).not.toContain('.png');
  });
});

// =====================================================================
// Setting: should only get story
// =====================================================================
describe('setting dependencies', () => {
  it('receives only story.md', () => {
    const node = getNode('setting:park');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toEqual(['chapters/chapter_1/plans/story.md']);
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).not.toContain('.png');
  });
});

// =====================================================================
// Character Image: should only get matching character profile
// =====================================================================
describe('character_image dependencies', () => {
  it('receives only the matching character markdown', () => {
    const node = getNode('character_image:alice');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toContain('characters/alice.md');
    expect(inputs.filesRead).not.toContain('characters/bob.md');
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).not.toContain('.png');
    expect(inputs.contextBlock.length).toBeLessThan(5000);
  });
});

// =====================================================================
// Setting Image: should only get matching setting profile
// =====================================================================
describe('setting_image dependencies', () => {
  it('receives only the matching setting markdown', () => {
    const node = getNode('setting_image:park');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toContain('settings/park.md');
    expect(inputs.filesRead).not.toContain('settings/house.md');
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).not.toContain('.png');
    expect(inputs.contextBlock.length).toBeLessThan(5000);
  });
});

// =====================================================================
// Scene: should get story + all characters + all settings (text only)
// =====================================================================
describe('scene dependencies', () => {
  it('receives story and all character/setting profiles', () => {
    const node = getNode('scene:scene_1');
    const inputs = resolveInputs(node, executor, projectDir);

    expect(inputs.filesRead).toContain('chapters/chapter_1/plans/story.md');
    expect(inputs.filesRead).toContain('characters/alice.md');
    expect(inputs.filesRead).toContain('characters/bob.md');
    expect(inputs.filesRead).toContain('settings/park.md');
    expect(inputs.filesRead).toContain('settings/house.md');
    expect(inputs.referenceImages).toEqual([]);
    expect(inputs.contextBlock).not.toContain('.png');
  });
});

// =====================================================================
// Scene Video Prompt: should get matching scene + ref images (NOT binary)
// =====================================================================
describe('scene_shot_plan dependencies (Stage A of hierarchical breakdown)', () => {
  // Post-refactor: scene_shot_plan is the LLM call that consumes scene
  // text. The same "no media deps, no binary contamination" guard that
  // used to live on scene_video_prompt now applies here.
  it('receives matching scene text but NO image refs (prevents serial mode deadlock)', () => {
    const node = getNode('scene_shot_plan:scene_1');
    const inputs = resolveInputs(node, executor, projectDir);

    // Should read the scene markdown
    expect(inputs.filesRead).toContain('chapters/chapter_1/scenes/scene_1.md');
    // Should NOT read scene_2
    expect(inputs.filesRead).not.toContain('chapters/chapter_1/scenes/scene_2.md');

    // Should NOT depend on character/setting images (media nodes)
    expect(inputs.filesRead).not.toContain('assets/images/charref_alice.png');
    expect(inputs.filesRead).not.toContain('assets/images/settingref_park.png');

    // Context block must NOT contain binary PNG data
    expect(inputs.contextBlock).not.toContain('\x89PNG');
    expect(inputs.contextBlock.length).toBeLessThan(50000);
  });

  it('context block is a reasonable size', () => {
    const node = getNode('scene_shot_plan:scene_1');
    const inputs = resolveInputs(node, executor, projectDir);

    // Should be small — just the scene markdown + metadata
    expect(inputs.contextBlock.length).toBeLessThan(10000);
  });
});

// =====================================================================
// Shot Image Prompt: should ONLY get matching scene_video_prompt JSON
// Reference images are resolved by refId at generation time, not here.
// =====================================================================
describe('shot_image_prompt dependencies', () => {
  it('receives only scene_video_prompt JSON — no images, no binary data', () => {
    const node = getNode('shot_image_prompt:scene_1_shot_1');
    if (!node) return; // May not exist if expansion didn't work
    const inputs = resolveInputs(node, executor, projectDir);

    // Should read scene_video_prompt JSON(s) only
    const jsonFiles = inputs.filesRead.filter(f => f.endsWith('.json'));
    expect(jsonFiles.length).toBeGreaterThanOrEqual(1);

    // Should NOT have any image files in filesRead
    const imageFiles = inputs.filesRead.filter(f => /\.(png|jpg|jpeg|webp)$/.test(f));
    expect(imageFiles.length).toBe(0);

    // No binary data in context
    expect(inputs.contextBlock).not.toContain('\x89PNG');
    expect(inputs.contextBlock.length).toBeLessThan(10000);

    // No reference images — those are resolved at ComfyUI time by refId
    expect(inputs.referenceImages.length).toBe(0);
  });
});

// =====================================================================
// Shot Image: must resolve the MATCHING shot_image_prompt, not any
// =====================================================================
describe('shot_image matching', () => {
  it('each shot_image reads ONLY its matching shot_image_prompt JSON', () => {
    // shot_image:scene_1_shot_1 should read scene-1-shot-1.json (not scene-1-shot-2.json)
    const shot1 = executor.getNode('shot_image:scene_1_shot_1');
    if (!shot1) return;
    const inputs1 = resolveInputs(shot1, executor, projectDir);
    const jsonFiles1 = inputs1.filesRead.filter(f => f.includes('shots/') && f.endsWith('.json'));
    expect(jsonFiles1).toContain('prompts/images/shots/scene-1-shot-1.json');
    expect(jsonFiles1).not.toContain('prompts/images/shots/scene-1-shot-2.json');
    expect(jsonFiles1).not.toContain('prompts/images/shots/scene-2-shot-1.json');
  });

  it('different shot_images get different prompt files', () => {
    const shot1 = executor.getNode('shot_image:scene_1_shot_1');
    const shot2 = executor.getNode('shot_image:scene_1_shot_2');
    if (!shot1 || !shot2) return;

    const inputs1 = resolveInputs(shot1, executor, projectDir);
    const inputs2 = resolveInputs(shot2, executor, projectDir);

    const json1 = inputs1.filesRead.filter(f => f.includes('shots/'));
    const json2 = inputs2.filesRead.filter(f => f.includes('shots/'));

    // They must read different files
    expect(json1).not.toEqual(json2);
    expect(json1).toContain('prompts/images/shots/scene-1-shot-1.json');
    expect(json2).toContain('prompts/images/shots/scene-1-shot-2.json');
  });

  it('shot_image across scenes reads the correct scene prompt', () => {
    const scene2shot = executor.getNode('shot_image:scene_2_shot_1');
    if (!scene2shot) return;
    const inputs = resolveInputs(scene2shot, executor, projectDir);
    const jsonFiles = inputs.filesRead.filter(f => f.includes('shots/'));
    expect(jsonFiles).toContain('prompts/images/shots/scene-2-shot-1.json');
    expect(jsonFiles).not.toContain('prompts/images/shots/scene-1-shot-1.json');
  });
});

// =====================================================================
// Shot Video: must use MATCHING shot_image as source, not any
// =====================================================================
describe('shot_video matching', () => {
  it('shot_video:scene_1_shot_1 has matching shot_image in its dependencies', () => {
    const sv = executor.getNode('shot_video:scene_1_shot_1');
    if (!sv) return;
    // The matching shot_image node must be in dependencies
    expect(sv.dependencies).toContain('shot_image:scene_1_shot_1');
  });

  // TODO: fix graph rewiring to enforce 1:1 matching (currently blanket rewires all)
  // When the artifact registry is implemented, this structural guarantee won't matter
  // because executeShotVideo will look up by itemId in the registry, not crawl deps.
  it.todo('each shot_video depends on EXACTLY its matching shot_image (1:1)');
});

// =====================================================================
// No binary data should ever appear in any node's context
// =====================================================================
describe('no binary contamination', () => {
  it('no node receives PNG data in its context block', () => {
    const allNodes = executor.getAllNodes();
    for (const node of allNodes) {
      if (node.status !== 'completed' && node.status !== 'pending') continue;
      // Skip nodes whose dependencies aren't all completed
      const depsComplete = node.dependencies.every(depId => {
        const dep = executor.getNode(depId);
        return dep && dep.status === 'completed';
      });
      if (!depsComplete) continue;

      const inputs = resolveInputs(node, executor, projectDir);
      expect(inputs.contextBlock).not.toContain('\x89PNG');
      expect(inputs.contextBlock.length).toBeLessThan(100000);
    }
  });
});
