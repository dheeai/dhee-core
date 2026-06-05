/**
 * Walker-lane usage telemetry (issue #102 #0).
 *
 * The llm.generate runner records one telemetry line per real LLM call,
 * tagged lane='walker' + node/item, with the provider's cached-token
 * count. This drives the real runner with a stub client that returns
 * usage and asserts the record lands in the sink (temp path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLlmGenerateRunner } from '../../../src/dag/runners/llmGenerate.js';
import { readUsageRecords } from '../../../src/core/llm/usageTelemetry.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

let bundleDir: string;
let projectDir: string;
let telDir: string;
let telFile: string;
let prevPath: string | undefined;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'tel-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'tel-proj-'));
  telDir = mkdtempSync(join(tmpdir(), 'tel-out-'));
  telFile = join(telDir, 'llm-usage.jsonl');
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  prevPath = process.env['DHEE_USAGE_TELEMETRY_PATH'];
  process.env['DHEE_USAGE_TELEMETRY_PATH'] = telFile;
  delete process.env['DHEE_USAGE_TELEMETRY_DISABLED'];
});

afterEach(() => {
  if (prevPath === undefined) delete process.env['DHEE_USAGE_TELEMETRY_PATH'];
  else process.env['DHEE_USAGE_TELEMETRY_PATH'] = prevPath;
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(telDir, { recursive: true, force: true });
});

function makeCtx(config: Record<string, unknown>, itemId?: string): RunnerContext {
  const node: NodeDef = {
    id: 'shot_image_prompt',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'md', pattern: 'out.md' },
    runner: { tool: 'llm.generate', config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: {},
    ...(itemId !== undefined ? { itemId } : {}),
    log: () => {},
  };
}

describe('llm.generate — walker usage telemetry', () => {
  it('records a lane=walker line with node/item + cached tokens when the client reports usage', async () => {
    writeFileSync(join(bundleDir, 'prompts/p.md'), 'Write something.');
    const client = {
      async generate() {
        return {
          content: 'ok',
          usage: {
            promptTokens: 5000,
            completionTokens: 80,
            totalTokens: 5080,
            cost: 0.0003,
            cachedPromptTokens: 4800,
          },
        };
      },
      getModel: () => 'deepseek/deepseek-v4-flash',
    };
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    const result = await runner.run(
      makeCtx({ promptTemplate: 'prompts/p.md', outputPath: 'out.md', tier: 'medium' }, 'scene_1_shot_2'),
    );
    expect(result.ok).toBe(true);

    const recs = readUsageRecords(telFile);
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    expect(r.lane).toBe('walker');
    expect(r.nodeId).toBe('shot_image_prompt');
    expect(r.itemId).toBe('scene_1_shot_2');
    expect(r.model).toBe('deepseek/deepseek-v4-flash');
    expect(r.promptTokens).toBe(5000);
    expect(r.cachedTokens).toBe(4800);
    expect(r.cachedRatio).toBeCloseTo(0.96, 5);
    expect(r.costUsd).toBe(0.0003);
  });

  it('does not record when the client reports no usage', async () => {
    writeFileSync(join(bundleDir, 'prompts/p.md'), 'Write something.');
    const client = {
      async generate() {
        return { content: 'ok' }; // no usage
      },
      getModel: () => 'stub-model',
    };
    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ promptTemplate: 'prompts/p.md', outputPath: 'out.md', tier: 'medium' }));
    expect(result.ok).toBe(true);
    expect(readUsageRecords(telFile)).toHaveLength(0);
  });
});
