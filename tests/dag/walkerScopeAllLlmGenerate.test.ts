/**
 * Regression: `scope: 'all'` against a genuine per-item collection must
 * inline CONTENT for an `llm.generate` consumer, not a raw id→path map.
 *
 * Before the fix, the walker always resolved scope='all' to
 * { [itemId]: absolutePath } regardless of the consuming runner.
 * `llm.generate`'s template substitution just JSON.stringifies whatever
 * it's handed, so the prompt silently got useless file-path text instead
 * of the upstream content the bundle author meant to inline (verified
 * bug: narrative_speech_shot_by_shot's shot_state node consumes
 * scene_staging via scope:'all' expecting the staging TEXT, but only
 * ever received path strings).
 *
 * The fix is scoped to the CONSUMING node's runner tool: `llm.generate`
 * gets { [itemId]: content } (parsed JSON for JSON-format producers, raw
 * text otherwise); every other runner (comfy.*, ffmpeg.*, …) must keep
 * getting the original path map — they resolve cross-collection
 * references (e.g. an image runner reading a character reference image
 * by id) and need real paths, not inlined text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner, RunnerContext } from '../../src/dag/schema.js';

let projectDir: string;
let llmSeenInput: unknown;
let comfySeenInput: unknown;

/** Writes per-item staging content so we can assert on it downstream. */
function makeStagingStub(): Runner {
  return {
    describe: () => ({ id: 'stub.staging', displayName: 'stub', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    async run(ctx: RunnerContext) {
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, `staging text for ${ctx.itemId}`);
      return { ok: true, outputPath: out };
    },
  };
}

/** Simulates the `llm.generate` runner: just records what it was handed. */
function makeLlmStub(): Runner {
  return {
    describe: () => ({ id: 'llm.generate', displayName: 'stub', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    async run(ctx: RunnerContext) {
      llmSeenInput = ctx.inputs['scene_staging'];
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '');
      return { ok: true, outputPath: out };
    },
  };
}

/** Simulates a comfy-style runner that legitimately needs paths, not content. */
function makeComfyStub(): Runner {
  return {
    describe: () => ({ id: 'comfy.stub', displayName: 'stub', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    async run(ctx: RunnerContext) {
      comfySeenInput = ctx.inputs['scene_staging'];
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '');
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'scopeall-llm-'));
  llmSeenInput = undefined;
  comfySeenInput = undefined;
  __resetGlobalRegistryForTesting();
  const reg = getGlobalRegistry();
  reg.register({ tool: 'stub.staging', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] }, makeStagingStub());
  reg.register({ tool: 'llm.generate', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] }, makeLlmStub());
  reg.register({ tool: 'comfy.stub', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] }, makeComfyStub());
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

function makeBundle(goal: 'consumer' | 'comfy_consumer'): DagBundle {
  return {
    id: 'scopeall-llm-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal,
    nodes: [
      {
        id: 'scenes_plan',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/scenes_plan.json' },
        runner: { tool: 'stub.staging', config: {} },
      },
      {
        id: 'scene_staging',
        kind: 'collection',
        itemSource: 'scenes_plan',
        itemKey: 'scenes',
        inputs: [{ from: 'scenes_plan', usage: 'input' }],
        outputs: { format: 'md', pattern: 'staging/{{item_id}}.md' },
        runner: { tool: 'stub.staging', config: {} },
      },
      {
        id: 'consumer',
        kind: 'stage',
        inputs: [{ from: 'scene_staging', usage: 'context', scope: 'all' }],
        outputs: { format: 'md', pattern: 'out/llm.md' },
        runner: { tool: 'llm.generate', config: {} },
      },
      {
        id: 'comfy_consumer',
        kind: 'stage',
        inputs: [{ from: 'scene_staging', usage: 'context', scope: 'all' }],
        outputs: { format: 'image', pattern: 'out/comfy.png' },
        runner: { tool: 'comfy.stub', config: {} },
      },
    ],
  };
}

function preSeed(): void {
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  writeFileSync(
    join(projectDir, 'plans/scenes_plan.json'),
    JSON.stringify({ scenes: [{ id: 'scene_1' }, { id: 'scene_2' }] }),
  );
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'p',
      walkState: {
        bundleSource: 'built-in:scopeall-llm-test',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: { scenes_plan: { status: 'completed', outputPath: 'plans/scenes_plan.json' } },
        lastInvalidatedIds: [],
      },
    }),
  );
}

describe("walker scope: 'all' consumed by llm.generate vs. other runners", () => {
  it('inlines per-item CONTENT for an llm.generate consumer', async () => {
    preSeed();
    const result = await walkBundle({ projectDir, bundle: makeBundle('consumer'), bundleSource: 'built-in:scopeall-llm-test' });
    expect(result.ok).toBe(true);

    expect(llmSeenInput).toEqual({
      scene_1: 'staging text for scene_1',
      scene_2: 'staging text for scene_2',
    });
  });

  it('keeps the original id→path map for a non-llm.generate consumer (e.g. comfy.*)', async () => {
    preSeed();
    const result = await walkBundle({ projectDir, bundle: makeBundle('comfy_consumer'), bundleSource: 'built-in:scopeall-llm-test' });
    expect(result.ok).toBe(true);

    const paths = comfySeenInput as Record<string, string>;
    expect(Object.keys(paths).sort()).toEqual(['scene_1', 'scene_2']);
    expect(paths['scene_1']).toMatch(/staging[/\\]scene_1\.md$/);
    expect(paths['scene_2']).toMatch(/staging[/\\]scene_2\.md$/);
  });
});
