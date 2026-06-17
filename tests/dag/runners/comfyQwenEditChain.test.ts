/**
 * comfy.qwen_edit_chain — early validation + chain-base resolution.
 *
 * This runner instantiates ComfyUIClient directly (no clientFactory
 * injection), so the upload/queue/download path needs a live Comfy and
 * is NOT unit-testable here. We cover ONLY the deterministic branches
 * that return BEFORE any dynamic import / client construction:
 *   - missing workflowPath / outputPath
 *   - missing ctx.bundleDir
 *   - resume short-circuit (output already exists)
 *   - missing shot_image_prompt upstream
 *   - "no usable base image" (the chain-base resolution falling through
 *     priors → setting → character with nothing usable)
 * plus describe().
 *
 * The base-pick logic's SUCCESS branch proceeds to network I/O and is
 * exercised by the e2e suite, not here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { comfyQwenEditChainRunner, selectQwenBase } from '../../../src/dag/runners/comfyQwenEditChain.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

let projectDir: string;
let bundleDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'qwen-proj-'));
  bundleDir = mkdtempSync(join(tmpdir(), 'qwen-bundle-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
});

function makeCtx(
  config: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  opts: { bundleDir?: string | undefined } = {},
): RunnerContext {
  const node: NodeDef = {
    id: 'shot_image',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'image', pattern: 'out.png' },
    runner: { tool: 'comfy.qwen_edit_chain', config },
  };
  return {
    projectDir,
    bundleDir: 'bundleDir' in opts ? opts.bundleDir : bundleDir,
    node,
    inputs,
    itemId: 'scene_1_shot_1',
    log: () => {},
  } as RunnerContext;
}

const baseCfg = () => ({ workflowPath: 'workflows/qwen.json', outputPath: 'out.png' });
const validPrompt = () => ({
  view: 'front view',
  elevation: 'eye level',
  distance: 'medium shot',
  deltaText: 'character turns to face camera',
  characters: ['hero'],
});

describe('comfy.qwen_edit_chain — early validation', () => {
  it('fails when workflowPath is missing', async () => {
    const r = await comfyQwenEditChainRunner.run(makeCtx({ outputPath: 'out.png' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing workflowPath or outputPath/);
  });

  it('fails when outputPath is missing', async () => {
    const r = await comfyQwenEditChainRunner.run(makeCtx({ workflowPath: 'w.json' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing workflowPath or outputPath/);
  });

  it('fails when ctx.bundleDir is absent', async () => {
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), { shot_image_prompt: validPrompt() }, { bundleDir: undefined }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ctx\.bundleDir required/);
  });

  it('resume short-circuits when the output already exists', async () => {
    writeFileSync(join(projectDir, 'out.png'), Buffer.from('existing'));
    const r = await comfyQwenEditChainRunner.run(makeCtx(baseCfg(), { shot_image_prompt: validPrompt() }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.metadata).toMatchObject({ skipped: true });
  });

  it('does NOT short-circuit when forceRerun is set (falls through to input validation)', async () => {
    writeFileSync(join(projectDir, 'out.png'), Buffer.from('existing'));
    // forceRerun + no shot_image_prompt → should reach the missing-prompt error.
    const r = await comfyQwenEditChainRunner.run(
      makeCtx({ ...baseCfg(), forceRerun: true }, {}),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no upstream prompt with Qwen camera-token shape/);
  });

  it('fails when shot_image_prompt upstream is missing', async () => {
    const r = await comfyQwenEditChainRunner.run(makeCtx(baseCfg(), {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no upstream prompt with Qwen camera-token shape/);
  });

  it('fails when shot_image_prompt is not an object', async () => {
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), { shot_image_prompt: 'not-an-object' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no upstream prompt with Qwen camera-token shape/);
  });

  it('resolves the prompt by SHAPE from a non-"shot_image_prompt" input (e.g. plate_prompt)', async () => {
    // The camera-token prompt arrives under a different key. The runner must
    // still find it by shape and proceed PAST prompt-resolution to base-pick
    // (proven by the "no usable base image" error, not the missing-prompt one).
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), { plate_prompt: validPrompt() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toMatch(/no upstream prompt/);
      expect(r.error).toMatch(/no usable base image/);
    }
  });

  // Counter-test: an input that is an object but LACKS the camera-token
  // fields must NOT be mistaken for the prompt.
  it('does NOT treat a non-camera-token object as the prompt', async () => {
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), { some_other_json: { imagePrompt: 'a Klein-shaped prompt' } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no upstream prompt with Qwen camera-token shape/);
  });
});

describe('selectQwenBase — base-image priority', () => {
  const setMap = { interview_room: '/s/interview_room.png', lobby: '/s/lobby.png' };
  const charMap = { hero: '/c/hero.png' };

  it('explicit baseId selects THE matching setting (multi-setting plate case)', () => {
    const r = selectQwenBase({ baseId: 'lobby' }, [], setMap, charMap);
    expect(r.path).toBe('/s/lobby.png');
    expect(r.source).toMatch(/explicit baseId/);
  });

  it('baseId falls back to a character when no setting matches', () => {
    const r = selectQwenBase({ baseId: 'hero' }, [], {}, charMap);
    expect(r.path).toBe('/c/hero.png');
    expect(r.source).toMatch(/character 'hero' \(explicit baseId\)/);
  });

  it('a prior shot OUTRANKS baseId (chain stays a chain)', () => {
    const r = selectQwenBase(
      { baseId: 'lobby', chosenBaseShotNumber: 5 },
      [{ shotNumber: 5, outputAbs: '/p/shot5.png' }],
      setMap,
      charMap,
    );
    expect(r.path).toBe('/p/shot5.png');
  });

  it('without baseId or priors, falls back to the FIRST setting', () => {
    const r = selectQwenBase({}, [], setMap, charMap);
    expect(r.path).toBe('/s/interview_room.png');
  });

  it('returns null when nothing is available', () => {
    const r = selectQwenBase({}, [], {}, {});
    expect(r.path).toBeNull();
  });
});

describe('comfy.qwen_edit_chain — chain-base resolution (no usable base)', () => {
  it('fails with a diagnostic count when there are no priors, settings or characters', async () => {
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), { shot_image_prompt: validPrompt() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no usable base image/);
      expect(r.error).toMatch(/priors=0/);
      expect(r.error).toMatch(/settings=0/);
      expect(r.error).toMatch(/chars=0/);
    }
  });

  it('reports counts from the provided (but non-existent-path) maps', async () => {
    // setting_image points at a path that does not exist → existsSync fails
    // → still "no usable base image", but the diagnostic counts the maps.
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), {
        shot_image_prompt: validPrompt(),
        setting_image: { tavern: join(projectDir, 'missing_setting.png') },
        character_image: { hero: join(projectDir, 'missing_hero.png') },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no usable base image/);
      expect(r.error).toMatch(/settings=1/);
      expect(r.error).toMatch(/chars=1/);
    }
  });

  it('falls back to a prior shot path; non-existent prior path → no usable base', async () => {
    const r = await comfyQwenEditChainRunner.run(
      makeCtx(baseCfg(), {
        shot_image_prompt: { ...validPrompt(), chosenBaseShotNumber: 2 },
        shot_image: [{ shotNumber: 2, outputAbs: join(projectDir, 'missing_prior.png') }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no usable base image/);
      expect(r.error).toMatch(/priors=1/);
    }
  });
});

describe('comfy.qwen_edit_chain — describe()', () => {
  it('reports its id, required config and cloud cost hint', () => {
    const d = comfyQwenEditChainRunner.describe();
    expect(d.id).toBe('comfy.qwen_edit_chain');
    expect(d.costHint).toBe('cloud_gpu');
    expect(d.configSchema?.required).toEqual(['workflowPath', 'outputPath']);
    expect(d.modalities?.output).toEqual(['image']);
  });
});
