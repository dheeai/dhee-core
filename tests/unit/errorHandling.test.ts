/**
 * Error handling tests across core modules:
 * - JSON schema validation (schemas.ts)
 * - Image validation (imageValidator.ts)
 * - Dependency graph error propagation (DependencyGraphExecutor.ts)
 * - Schema normalization edge cases (normalizeSceneVideoPrompt)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  validateWithSchema,
  normalizeSceneVideoPrompt,
  sceneVideoPromptSchema,
} from '../../src/core/planner/schemas.js';
import { validateGeneratedImage } from '../../src/core/planner/imageValidator.js';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import type { ExecutionNode, ExecutorState } from '../../src/core/planner/types.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';

// ============================================================================
// Helpers
// ============================================================================

const TMP_DIR = join(tmpdir(), `dhee-error-tests-${Date.now()}`);

/** Minimal template for building executors directly from state. */
function makeMinimalTemplate(): VideoTemplate {
  return {
    id: 'test',
    displayName: 'Test',
    description: 'test',
    version: '1.0.0',
    defaultStyle: 'default',
    styles: [{ id: 'default', displayName: 'Default', description: '', promptModifiers: [], negativePrompt: [] }],
    inputTypes: [],
    artifactTypes: {},
    contextVariables: {},
    orchestratorPrompt: 'orchestrator.md',
  };
}

/** Build an executor from a raw node map (bypasses planning). */
function buildExecutor(nodes: Record<string, ExecutionNode>): DependencyGraphExecutor {
  const state: ExecutorState = {
    nodes,
    targetArtifacts: [],
    goalDescription: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return DependencyGraphExecutor.fromState(state, makeMinimalTemplate());
}

/** Helper to create a simple execution node. */
function node(
  id: string,
  deps: string[] = [],
  dependents: string[] = [],
  status: ExecutionNode['status'] = 'pending',
): ExecutionNode {
  return {
    id,
    typeId: id,
    status,
    displayName: id,
    isExpensive: false,
    isCollection: false,
    dependencies: deps,
    dependents,
  };
}

// ============================================================================
// 1. JSON Schema Validation Errors
// ============================================================================

describe('JSON schema validation errors', () => {
  // ---- scene_video_prompt ----
  describe('scene_video_prompt', () => {
    it('rejects empty shots array', () => {
      const result = validateWithSchema('scene_video_prompt', { shots: [] });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('shots');
      }
    });

    it('rejects missing shots field entirely', () => {
      const result = validateWithSchema('scene_video_prompt', {});
      expect(result.valid).toBe(false);
    });

    it('rejects shot without description or firstFrame', () => {
      const result = validateWithSchema('scene_video_prompt', {
        shots: [{ shotNumber: 1 }],
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('firstFrame.description or description');
      }
    });

    it('rejects shot with wrong type for shotNumber', () => {
      const result = validateWithSchema('scene_video_prompt', {
        shots: [{ shotNumber: 'one', description: 'A shot' }],
      });
      expect(result.valid).toBe(false);
    });

    it('accepts valid scene_video_prompt with firstFrame', () => {
      const result = validateWithSchema('scene_video_prompt', {
        shots: [{ shotNumber: 1, firstFrame: { description: 'A wide shot of a valley' } }],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts valid scene_video_prompt with top-level description', () => {
      const result = validateWithSchema('scene_video_prompt', {
        shots: [{ shotNumber: 1, description: 'A wide shot of a valley' }],
      });
      expect(result.valid).toBe(true);
    });
  });

  // ---- shot_image_prompt ----
  describe('shot_image_prompt', () => {
    it('rejects empty imagePrompt in single-frame format', () => {
      const result = validateWithSchema('shot_image_prompt', {
        imagePrompt: '',
        generationMode: 'text_to_image',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects missing generationMode in single-frame format', () => {
      // The union tries both branches; neither should match
      const result = validateWithSchema('shot_image_prompt', {
        imagePrompt: 'A dramatic sunset',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects multi-frame with empty first_frame imagePrompt', () => {
      const result = validateWithSchema('shot_image_prompt', {
        frames: {
          first_frame: { imagePrompt: '', generationMode: 'image_text_to_image' },
        },
      });
      expect(result.valid).toBe(false);
    });

    it('rejects multi-frame missing frames.first_frame entirely', () => {
      const result = validateWithSchema('shot_image_prompt', {
        frames: {},
      });
      expect(result.valid).toBe(false);
    });

    it('accepts valid single-frame shot_image_prompt', () => {
      const result = validateWithSchema('shot_image_prompt', {
        imagePrompt: 'A dramatic sunset over mountains',
        generationMode: 'text_to_image',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts valid multi-frame shot_image_prompt', () => {
      const result = validateWithSchema('shot_image_prompt', {
        frames: {
          first_frame: { imagePrompt: 'A person standing', generationMode: 'image_text_to_image' },
          last_frame: { imagePrompt: 'The person walks away', generationMode: 'edit_first_frame' },
        },
      });
      expect(result.valid).toBe(true);
    });
  });

  // ---- character_image / setting_image ----
  describe('character_image and setting_image', () => {
    it('rejects missing imagePrompt', () => {
      const result = validateWithSchema('character_image', {
        negativePrompt: 'blur',
        aspectRatio: '1:1',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects empty imagePrompt', () => {
      const result = validateWithSchema('character_image', {
        imagePrompt: '',
        negativePrompt: 'blur',
        aspectRatio: '1:1',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects missing negativePrompt', () => {
      const result = validateWithSchema('setting_image', {
        imagePrompt: 'A forest clearing',
        aspectRatio: '1:1',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects missing aspectRatio', () => {
      const result = validateWithSchema('setting_image', {
        imagePrompt: 'A forest clearing',
        negativePrompt: 'blur',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects all fields empty strings', () => {
      const result = validateWithSchema('character_image', {
        imagePrompt: '',
        negativePrompt: '',
        aspectRatio: '',
      });
      expect(result.valid).toBe(false);
    });

    it('accepts valid character_image', () => {
      const result = validateWithSchema('character_image', {
        imagePrompt: 'A tall knight in shining armor',
        negativePrompt: 'blurry, low quality',
        aspectRatio: '1:1',
      });
      expect(result.valid).toBe(true);
    });
  });

  // ---- unknown schema type ----
  describe('unknown schema type', () => {
    it('accepts anything for unknown node type', () => {
      const result = validateWithSchema('nonexistent_type', { foo: 'bar' });
      expect(result.valid).toBe(true);
    });
  });
});

// ============================================================================
// 2. Image Validation Errors
// ============================================================================

describe('Image validation errors', () => {
  // Set up temp dir and files once
  mkdirSync(TMP_DIR, { recursive: true });

  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const JPEG_HEADER = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);

  // Minimal valid PNG with IHDR (width=100, height=200)
  const VALID_PNG = Buffer.concat([
    PNG_HEADER,
    // IHDR chunk length (13 bytes)
    Buffer.from([0x00, 0x00, 0x00, 0x0D]),
    // IHDR tag
    Buffer.from('IHDR'),
    // width = 100
    Buffer.alloc(4),
    // height = 200
    Buffer.alloc(4),
    // bit depth, color type, compression, filter, interlace
    Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00]),
    // CRC placeholder
    Buffer.alloc(4),
  ]);
  // Write width=100 at offset 16, height=200 at offset 20
  VALID_PNG.writeUInt32BE(100, 16);
  VALID_PNG.writeUInt32BE(200, 20);

  const pngPath = join(TMP_DIR, 'valid.png');
  const jpegPath = join(TMP_DIR, 'valid.jpg');
  const truncatedPath = join(TMP_DIR, 'truncated.png');
  const gifPath = join(TMP_DIR, 'fake.gif');

  writeFileSync(pngPath, VALID_PNG);
  writeFileSync(jpegPath, Buffer.concat([JPEG_HEADER, Buffer.alloc(100)]));
  writeFileSync(truncatedPath, Buffer.from([0x89, 0x50, 0x4E])); // 3 bytes < 8
  writeFileSync(gifPath, Buffer.from('GIF89a' + '\x00'.repeat(20)));

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('returns error for non-existent file', async () => {
    const result = await validateGeneratedImage('/no/such/file.png', 'test');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for truncated file (< 8 bytes)', async () => {
    const result = await validateGeneratedImage(truncatedPath, 'test');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too small');
  });

  it('returns error for wrong format (GIF not PNG/JPEG)', async () => {
    const result = await validateGeneratedImage(gifPath, 'test');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not a valid PNG or JPEG');
  });

  it('returns error for dimension mismatch on PNG', async () => {
    const result = await validateGeneratedImage(pngPath, 'test', { width: 512, height: 512 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Dimension mismatch');
    expect(result.error).toContain('100x200');
    expect(result.error).toContain('512x512');
  });

  it('passes valid PNG without dimension check', async () => {
    const result = await validateGeneratedImage(pngPath, 'test');
    expect(result.valid).toBe(true);
  });

  it('passes valid PNG with correct dimensions', async () => {
    const result = await validateGeneratedImage(pngPath, 'test', { width: 100, height: 200 });
    expect(result.valid).toBe(true);
  });

  it('passes valid JPEG without dimension check', async () => {
    const result = await validateGeneratedImage(jpegPath, 'test');
    expect(result.valid).toBe(true);
  });

  it('skips dimension check for JPEG (only PNG supported)', async () => {
    // JPEG dimension check is not implemented, so it should pass even with wrong dimensions
    const result = await validateGeneratedImage(jpegPath, 'test', { width: 999, height: 999 });
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// 3. Dependency Graph Error Propagation
// ============================================================================

describe('Dependency graph error propagation', () => {
  it('failed node blocks all downstream dependents', () => {
    // A -> B -> C (linear chain)
    const executor = buildExecutor({
      A: node('A', [], ['B']),
      B: node('B', ['A'], ['C']),
      C: node('C', ['B'], []),
    });

    // Initially A is ready
    expect(executor.getNextReady().map(n => n.id)).toEqual(['A']);

    // Fail A
    executor.markStarted('A');
    executor.markFailed('A', 'generation error');

    // B depends on A (failed) — should NOT be ready
    expect(executor.getNextReady()).toEqual([]);

    // C depends on B (pending, blocked) — also not ready
    const nodeB = executor.getNode('B')!;
    expect(nodeB.status).toBe('pending');
    const nodeC = executor.getNode('C')!;
    expect(nodeC.status).toBe('pending');
  });

  it('failed node stores error message', () => {
    const executor = buildExecutor({
      A: node('A', [], []),
    });
    executor.markStarted('A');
    executor.markFailed('A', 'LLM returned invalid JSON');

    const a = executor.getNode('A')!;
    expect(a.status).toBe('failed');
    expect(a.error).toBe('LLM returned invalid JSON');
  });

  it('retrying a failed node via invalidate + complete unblocks downstream', () => {
    // A -> B -> C
    const executor = buildExecutor({
      A: node('A', [], ['B']),
      B: node('B', ['A'], ['C']),
      C: node('C', ['B'], []),
    });

    // Fail A
    executor.markStarted('A');
    executor.markFailed('A', 'transient error');
    expect(executor.getNextReady()).toEqual([]);

    // Retry: invalidate A (resets to pending)
    executor.invalidateNode('A');
    expect(executor.getNode('A')!.status).toBe('pending');

    // A should be ready again
    expect(executor.getNextReady().map(n => n.id)).toEqual(['A']);

    // Complete A — B should now be ready
    executor.markStarted('A');
    const newlyReady = executor.markCompleted('A');
    expect(newlyReady.map(n => n.id)).toEqual(['B']);

    // Complete B — C should now be ready
    executor.markStarted('B');
    const readyAfterB = executor.markCompleted('B');
    expect(readyAfterB.map(n => n.id)).toEqual(['C']);
  });

  it('diamond dependency: node with multiple deps blocked by one failure', () => {
    // A -> C, B -> C (C depends on both A and B)
    const executor = buildExecutor({
      A: node('A', [], ['C']),
      B: node('B', [], ['C']),
      C: node('C', ['A', 'B'], []),
    });

    // Complete A, fail B
    executor.markStarted('A');
    executor.markCompleted('A');
    executor.markStarted('B');
    executor.markFailed('B', 'error');

    // C should NOT be ready (B failed)
    expect(executor.getNextReady()).toEqual([]);
  });

  it('diamond dependency: fixing failed branch unblocks join node', () => {
    const executor = buildExecutor({
      A: node('A', [], ['C']),
      B: node('B', [], ['C']),
      C: node('C', ['A', 'B'], []),
    });

    // Complete A, fail B
    executor.markStarted('A');
    executor.markCompleted('A');
    executor.markStarted('B');
    executor.markFailed('B', 'error');
    expect(executor.getNextReady()).toEqual([]);

    // Retry B
    executor.invalidateNode('B');
    executor.markStarted('B');
    const ready = executor.markCompleted('B');

    // C should now be ready
    expect(ready.map(n => n.id)).toEqual(['C']);
  });

  it('markFailed on unknown node throws', () => {
    const executor = buildExecutor({});
    expect(() => executor.markFailed('nonexistent', 'err')).toThrow('Unknown node');
  });

  it('markStarted on unknown node throws', () => {
    const executor = buildExecutor({});
    expect(() => executor.markStarted('nonexistent')).toThrow('Unknown node');
  });

  it('progress counts failed nodes correctly', () => {
    const executor = buildExecutor({
      A: node('A', [], ['B']),
      B: node('B', ['A'], []),
    });

    executor.markStarted('A');
    executor.markFailed('A', 'err');

    const progress = executor.getProgress();
    expect(progress.failed).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.total).toBe(2);
  });

  it('isComplete considers failed nodes as terminal (not blocking completion)', () => {
    // isComplete only checks for pending/in_progress/ready — failed is terminal
    const executor = buildExecutor({
      A: node('A', [], []),
    });
    executor.markStarted('A');
    executor.markFailed('A', 'err');
    // A failed node is terminal — isComplete returns true because nothing is pending
    expect(executor.isComplete()).toBe(true);
  });

  it('isComplete returns false when failed node has pending downstream', () => {
    // The downstream node stays pending (blocked by failed dep), so isComplete is false
    const executor = buildExecutor({
      A: node('A', [], ['B']),
      B: node('B', ['A'], []),
    });
    executor.markStarted('A');
    executor.markFailed('A', 'err');
    expect(executor.isComplete()).toBe(false);
  });
});

// ============================================================================
// 4. Schema Normalization Edge Cases
// ============================================================================

describe('Schema normalization edge cases', () => {
  it('shot with neither videoGenerationMode nor generationStrategy remains undefined (strategy now in shot_image_prompt)', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [{ shotNumber: 1, description: 'A landscape' }],
    });
    normalizeSceneVideoPrompt(data);
    expect(data.shots[0].generationStrategy).toBeUndefined();
  });

  it('shot with videoGenerationMode but no generationStrategy copies value', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [{ shotNumber: 1, description: 'A close-up', videoGenerationMode: 'i2v' }],
    });
    normalizeSceneVideoPrompt(data);
    expect(data.shots[0].generationStrategy).toBe('i2v');
  });

  it('shot with generationStrategy already set is left alone', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [{ shotNumber: 1, description: 'Action shot', generationStrategy: 'fmlfv' }],
    });
    normalizeSceneVideoPrompt(data);
    expect(data.shots[0].generationStrategy).toBe('fmlfv');
  });

  it('shot with both videoGenerationMode and generationStrategy keeps generationStrategy', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [{
        shotNumber: 1,
        description: 'A scene',
        videoGenerationMode: 'i2v',
        generationStrategy: 'flfv',
      }],
    });
    normalizeSceneVideoPrompt(data);
    // generationStrategy was already set, so videoGenerationMode should NOT overwrite it
    expect(data.shots[0].generationStrategy).toBe('flfv');
  });

  it('shot with unknown strategy value is preserved (not validated by normalizer)', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [{ shotNumber: 1, description: 'Test', generationStrategy: 'unknown_strategy' }],
    });
    normalizeSceneVideoPrompt(data);
    expect(data.shots[0].generationStrategy).toBe('unknown_strategy');
  });

  it('normalizes all shots in a multi-shot prompt', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [
        { shotNumber: 1, description: 'Shot A' },
        { shotNumber: 2, description: 'Shot B', videoGenerationMode: 'i2v' },
        { shotNumber: 3, description: 'Shot C', generationStrategy: 'fmlfv' },
      ],
    });
    normalizeSceneVideoPrompt(data);

    expect(data.shots[0].generationStrategy).toBeUndefined(); // no default — strategy now in shot_image_prompt
    expect(data.shots[1].generationStrategy).toBe('i2v');     // copied from videoGenerationMode
    expect(data.shots[2].generationStrategy).toBe('fmlfv');   // kept as-is
  });

  it('shot with videoGenerationMode copied preserves original videoGenerationMode field', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [{ shotNumber: 1, description: 'Test', videoGenerationMode: 'i2v_late_entry' }],
    });
    normalizeSceneVideoPrompt(data);
    expect(data.shots[0].videoGenerationMode).toBe('i2v_late_entry');
    expect(data.shots[0].generationStrategy).toBe('i2v_late_entry');
  });
});
