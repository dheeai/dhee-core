/**
 * Focused E2E test: shot_image_prompt reference images
 *
 * Reuses a completed pipeline checkpoint and only re-runs shot_image_prompt nodes
 * to validate that references are correctly populated.
 *
 * Run: pnpm vitest run tests/e2e/shot-refs.test.ts
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { cpSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createTestLLM,
  createTestExecutor,
  readJsonOutput,
  extractImageReferences,
} from './helpers.js';
import type { LLMClient } from '../../src/core/llm/index.js';
import type { ExecutorAgent } from '../../src/core/planner/ExecutorAgent.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';

// Find the most recent fully-completed E2E project to use as checkpoint
function findCompletedCheckpoint(): string | null {
  const fs = require('fs');
  const tmpDir = tmpdir();
  const dirs = fs.readdirSync(tmpDir)
    .filter((d: string) => d.startsWith('dhee-e2e-'))
    .map((d: string) => join(tmpDir, d))
    .sort()
    .reverse();

  for (const dir of dirs) {
    try {
      const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf-8'));
      const nodes = project.executorState?.nodes ?? {};
      const completed = Object.values(nodes).filter((n: any) => n.status === 'completed').length;
      // Need at least scene_video_prompt + character_image + setting_image completed
      const hasSceneVideoPrompts = Object.values(nodes).some((n: any) =>
        n.typeId === 'scene_video_prompt' && n.status === 'completed');
      const hasCharImages = Object.values(nodes).some((n: any) =>
        n.typeId === 'character_image' && n.status === 'completed');
      // Need a fully completed pipeline — at least 40 nodes including shot_image_prompts
      const hasShotPrompts = Object.values(nodes).some((n: any) =>
        n.typeId === 'shot_image_prompt' && (n.id as string).includes('shot_') && n.status === 'completed');
      if (completed >= 40 && hasSceneVideoPrompts && hasCharImages && hasShotPrompts) {
        return dir;
      }
    } catch { /* skip */ }
  }
  return null;
}

async function isLLMReachable(): Promise<boolean> {
  try {
    const url = process.env['LLM_BASE_URL'];
    if (!url) return false;
    const apiKey = process.env['LLM_API_KEY'] ?? '';
    const headers: Record<string, string> = {};
    if (apiKey && apiKey !== 'not-needed') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(10000), headers });
    return res.ok;
  } catch {
    return false;
  }
}

let LLM_AVAILABLE = false;

beforeAll(async () => {
  LLM_AVAILABLE = await isLLMReachable();
  if (!LLM_AVAILABLE) {
    console.log('LLM not reachable — skipping shot-refs tests');
  }
}, 15000);

describe('Shot Image Prompt References', () => {
  let projectDir: string;
  let llm: LLMClient;
  let executor: ExecutorAgent;
  let allNodes: ExecutionNode[];
  let testedNodeIds: string[] = [];

  beforeAll(async () => {
    if (!LLM_AVAILABLE) return;

    const checkpoint = findCompletedCheckpoint();
    if (!checkpoint) {
      console.log('No completed checkpoint found — skipping');
      LLM_AVAILABLE = false;
      return;
    }

    console.log(`Using checkpoint: ${checkpoint}`);

    // Copy checkpoint to a fresh dir so we don't mutate the original
    projectDir = join(tmpdir(), `dhee-shotref-${Date.now()}`);
    cpSync(checkpoint, projectDir, { recursive: true });

    // Invalidate only 2 shot_image_prompt nodes — enough to verify the fix
    const projectPath = join(projectDir, 'project.json');
    const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
    const nodes = project.executorState?.nodes ?? {};
    let invalidated = 0;
    const MAX_TO_TEST = 2;
    for (const [id, node] of Object.entries(nodes) as [string, any][]) {
      if (node.typeId === 'shot_image_prompt' && id.includes('shot_') && invalidated < MAX_TO_TEST) {
        // Delete old output file BEFORE clearing the path
        if (node.outputPath) {
          const outPath = join(projectDir, node.outputPath);
          if (existsSync(outPath)) {
            require('fs').unlinkSync(outPath);
          }
          // Also delete the prompt file that findExistingPromptFile would find
          const basename = node.outputPath.split('/').pop();
          if (basename) {
            const shotsDir = join(projectDir, 'prompts', 'images', 'shots');
            const promptPath = join(shotsDir, basename);
            if (existsSync(promptPath)) {
              require('fs').unlinkSync(promptPath);
            }
          }
        }

        testedNodeIds.push(id);
        node.status = 'pending';
        node.outputPath = undefined;
        node.startedAt = undefined;
        node.completedAt = undefined;
        node.error = undefined;
        invalidated++;
      }
    }

    require('fs').writeFileSync(projectPath, JSON.stringify(project, null, 2));
    console.log(`Invalidated ${invalidated} shot_image_prompt nodes`);

    // Create executor with stopAfterNodeType — stop once all shot_image_prompts complete
    llm = createTestLLM();
    executor = createTestExecutor(projectDir, llm, undefined, {
      skipMediaGeneration: true,
      stopAfterNodeType: 'shot_image_prompt',
    });

    console.log('Running shot_image_prompt nodes...');
    const start = Date.now();
    await executor.run('Re-generate shot image prompts');

    allNodes = executor.getExecutor().getAllNodes();
    const completed = allNodes.filter(n => n.status === 'completed').length;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`Done in ${elapsed}s: ${completed} completed, ${allNodes.length} total`);
  }, 300000); // 5 min — 1-2 LLM calls at ~60s each + overhead

  it('re-generated shot_image_prompts use image_text_to_image with references', () => {
    if (!LLM_AVAILABLE) return;

    // Only check the nodes we invalidated and re-ran
    const nodes = allNodes
      .filter(n => testedNodeIds.includes(n.id) && n.status === 'completed');
    expect(nodes.length).toBeGreaterThanOrEqual(1);

    let withRefs = 0;

    for (const node of nodes) {
      if (!node.outputPath?.endsWith('.json')) continue;

      const json = readJsonOutput(projectDir, node.outputPath!) as Record<string, unknown>;

      expect(json.imagePrompt).toBeDefined();
      expect(typeof json.imagePrompt).toBe('string');
      expect(json.negativePrompt).toBeDefined();
      expect(json.aspectRatio).toBeDefined();

      // Must be image_text_to_image with references
      expect(json.generationMode).toBe('image_text_to_image');
      expect(Array.isArray(json.references)).toBe(true);

      const refs = json.references as Array<Record<string, unknown>>;
      expect(refs.length).toBeGreaterThan(0);

      for (const ref of refs) {
        expect(typeof ref.imageNumber).toBe('number');
        expect(['character', 'setting']).toContain(ref.type);
        expect(typeof ref.refId).toBe('string');
        expect(ref.refId as string).toMatch(/^(character_image|setting_image):/);
      }

      // imagePrompt must reference each image N
      const imageRefs = extractImageReferences(json.imagePrompt as string);
      for (const ref of refs) {
        expect(imageRefs).toContain(ref.imageNumber as number);
      }

      withRefs++;
    }

    console.log(`${withRefs}/${nodes.length} re-generated shot_image_prompts use image_text_to_image with references`);
    expect(withRefs).toBe(nodes.filter(n => n.outputPath?.endsWith('.json')).length);
  });

  it('reference refIds resolve to completed nodes', () => {
    if (!LLM_AVAILABLE) return;

    const graph = executor.getExecutor();
    const nodes = allNodes
      .filter(n => testedNodeIds.includes(n.id) && n.status === 'completed');

    let checked = 0;
    for (const node of nodes) {
      if (!node.outputPath?.endsWith('.json')) continue;

      const json = readJsonOutput(projectDir, node.outputPath!) as {
        generationMode: string;
        imagePrompt: string;
        references: Array<{ imageNumber: number; type: string; refId: string }>;
      };

      if (json.references.length > 0) {
        for (const ref of json.references) {
          const refNode = graph.getNode(ref.refId);
          expect(refNode).toBeDefined();
          expect(refNode!.status).toBe('completed');
        }

        // No fabricated image numbers
        const imageRefs = extractImageReferences(json.imagePrompt);
        const validNumbers = new Set(json.references.map(r => r.imageNumber));
        for (const num of imageRefs) {
          expect(validNumbers.has(num)).toBe(true);
        }
        checked++;
      }
    }

    console.log(`Verified ${checked} shot prompts for reference consistency`);
    expect(checked).toBeGreaterThan(0);
  });
});
