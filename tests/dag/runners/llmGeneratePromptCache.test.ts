/**
 * Prompt-cache optimisation for collection nodes (issue #102).
 *
 * Collection nodes (shot_image_prompt, shot_motion_directive,
 * character_image, …) fan out into many LLM calls that share a large
 * invariant context and differ only by a per-item selector. To let the
 * provider's automatic prefix caching kick in, the runner splits a
 * rendered template at a CACHE BREAKPOINT into a stable `system` prefix
 * (byte-identical across every item) and a per-item `user` suffix.
 *
 * These tests drive the real runner with a stub client that captures the
 * exact messages sent, and assert the caching invariant: the system
 * prefix is identical across two different items, while the user suffix
 * carries the per-item delta. (No source-string matching — we run the
 * runner and inspect what it sends.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLlmGenerateRunner,
  splitOnCacheBreakpoint,
  CACHE_BREAKPOINT_MARKER,
} from '../../../src/dag/runners/llmGenerate.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

interface CapturedMsg {
  role: string;
  content: string;
}

function makeCapturingClient(capture: CapturedMsg[][]) {
  return {
    async generate(opts: { messages: CapturedMsg[] }) {
      capture.push(opts.messages.map((m) => ({ role: m.role, content: m.content })));
      return { content: 'stub output' };
    },
    getModel: () => 'stub-model',
  };
}

let bundleDir: string;
let projectDir: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'pcache-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'pcache-proj-'));
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(opts: {
  config: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  itemId?: string;
}): RunnerContext {
  const node: NodeDef = {
    id: 'shot_image_prompt',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'md', pattern: 'out.md' },
    runner: { tool: 'llm.generate', config: opts.config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: opts.inputs ?? {},
    ...(opts.itemId !== undefined ? { itemId: opts.itemId } : {}),
    log: () => {},
  };
}

// A collection-style template: invariant context (scenes_plan) before the
// breakpoint, the per-item selector after it.
const COLLECTION_TEMPLATE = [
  'You are writing a prompt for ONE shot.',
  '',
  'Shot data:',
  '{{scenes_plan}}',
  '',
  'World style:',
  '{{world_style}}',
  '',
  'Output ONLY the result.',
  '',
  CACHE_BREAKPOINT_MARKER,
  'This call is for shot id: {{item_id}} — find it in the shots array above.',
].join('\n');

const SCENES_PLAN = JSON.stringify({
  shots: [
    { id: 'scene_1_shot_1', desc: 'wide establishing' },
    { id: 'scene_1_shot_2', desc: 'close up' },
    { id: 'scene_1_shot_3', desc: 'over the shoulder' },
  ],
});

describe('splitOnCacheBreakpoint', () => {
  it('splits into prefix + suffix and strips the marker', () => {
    const r = splitOnCacheBreakpoint(`INVARIANT BLOCK\n${CACHE_BREAKPOINT_MARKER}\nPER ITEM`);
    expect(r).not.toBeNull();
    expect(r!.prefix).toBe('INVARIANT BLOCK');
    expect(r!.suffix).toBe('PER ITEM');
    expect(r!.prefix).not.toContain(CACHE_BREAKPOINT_MARKER);
    expect(r!.suffix).not.toContain(CACHE_BREAKPOINT_MARKER);
  });

  it('returns null when there is no marker', () => {
    expect(splitOnCacheBreakpoint('just one block, no marker')).toBeNull();
  });

  it('returns null when one side is empty (nothing to gain)', () => {
    expect(splitOnCacheBreakpoint(`${CACHE_BREAKPOINT_MARKER}\nonly suffix`)).toBeNull();
    expect(splitOnCacheBreakpoint(`only prefix\n${CACHE_BREAKPOINT_MARKER}`)).toBeNull();
  });

  it('splits on the FIRST marker only', () => {
    const r = splitOnCacheBreakpoint(`A\n${CACHE_BREAKPOINT_MARKER}\nB\n${CACHE_BREAKPOINT_MARKER}\nC`);
    expect(r!.prefix).toBe('A');
    expect(r!.suffix).toBe(`B\n${CACHE_BREAKPOINT_MARKER}\nC`);
  });
});

describe('llm.generate — cache-aware message split', () => {
  it('keeps the system prefix BYTE-IDENTICAL across items while the user suffix carries the per-item delta', async () => {
    writeFileSync(join(bundleDir, 'prompts/shot.md'), COLLECTION_TEMPLATE);
    const captured: CapturedMsg[][] = [];
    const client = makeCapturingClient(captured);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    const inputs = { scenes_plan: SCENES_PLAN, world_style: 'cinematic realism' };

    // Two different items, distinct outputPaths (so the path-skip doesn't
    // short-circuit the second call), same template + invariant inputs.
    const r1 = await runner.run(
      makeCtx({
        config: { promptTemplate: 'prompts/shot.md', outputPath: 'a.md', tier: 'medium' },
        inputs,
        itemId: 'scene_1_shot_1',
      }),
    );
    const r2 = await runner.run(
      makeCtx({
        config: { promptTemplate: 'prompts/shot.md', outputPath: 'b.md', tier: 'medium' },
        inputs,
        itemId: 'scene_1_shot_3',
      }),
    );

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(captured).toHaveLength(2);

    const [m1, m2] = captured;

    // Each call: a system prefix then a user suffix.
    expect(m1!.map((m) => m.role)).toEqual(['system', 'user']);
    expect(m2!.map((m) => m.role)).toEqual(['system', 'user']);

    const sys1 = m1!.find((m) => m.role === 'system')!.content;
    const sys2 = m2!.find((m) => m.role === 'system')!.content;
    const usr1 = m1!.find((m) => m.role === 'user')!.content;
    const usr2 = m2!.find((m) => m.role === 'user')!.content;

    // THE caching invariant: the (large) system prefix is identical
    // across items — so the provider caches it once and reuses it.
    expect(sys1).toBe(sys2);
    // The invariant context lives in the cached prefix...
    expect(sys1).toContain(SCENES_PLAN);
    expect(sys1).toContain('cinematic realism');
    // ...and the per-item selector lives in the (uncached) suffix.
    expect(usr1).not.toBe(usr2);
    expect(usr1).toContain('scene_1_shot_1');
    expect(usr2).toContain('scene_1_shot_3');
    // No leaked context into the suffix (keeps the per-item delta tiny).
    expect(usr1).not.toContain(SCENES_PLAN);

    // The marker itself is never sent to the model.
    for (const msgs of captured)
      for (const m of msgs) expect(m.content).not.toContain(CACHE_BREAKPOINT_MARKER);
  });

  it('falls back to a single user message for templates without the marker (backward compatible)', async () => {
    writeFileSync(join(bundleDir, 'prompts/plain.md'), 'Write a story about {{topic}}.');
    const captured: CapturedMsg[][] = [];
    const client = makeCapturingClient(captured);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    const result = await runner.run(
      makeCtx({
        config: { promptTemplate: 'prompts/plain.md', outputPath: 'out.md', tier: 'heavy' },
        inputs: { topic: 'dragons' },
      }),
    );

    expect(result.ok).toBe(true);
    expect(captured[0]!.map((m) => m.role)).toEqual(['user']);
    expect(captured[0]![0]!.content).toContain('Write a story about dragons.');
  });

  it('writes the LLM output to outputPath as usual when split', async () => {
    writeFileSync(join(bundleDir, 'prompts/shot.md'), COLLECTION_TEMPLATE);
    const client = makeCapturingClient([]);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(
      makeCtx({
        config: { promptTemplate: 'prompts/shot.md', outputPath: 'written.md', tier: 'medium' },
        inputs: { scenes_plan: SCENES_PLAN, world_style: 'x' },
        itemId: 'scene_1_shot_2',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readFileSync(join(projectDir, result.outputPath), 'utf-8')).toBe('stub output');
    }
  });
});
