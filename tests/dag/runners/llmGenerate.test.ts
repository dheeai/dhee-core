/**
 * Phase 1 — llm.generate runner.
 *
 * Tests map directly to the failure modes enumerated in
 * docs/bundle-migration-plan.md §3 Phase 1. The runner has a factory
 * (createLlmGenerateRunner) that accepts a stub LLM client factory for
 * unit testing — we never make real network calls here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLlmGenerateRunner, normalizeSceneShotIds } from '../../../src/dag/runners/llmGenerate.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

// ── Stub LLM client ────────────────────────────────────────────────────
// The runner's contract is: it receives a client factory that returns
// something with a `.generate(opts)` method and a `.getModel()` method.
// Tests configure the stub to simulate timeouts, malformed JSON,
// empty responses, abort, etc.

interface StubLlmClient {
  generate(opts: { messages: { role: string; content: string }[]; signal?: AbortSignal; responseFormat?: unknown }): Promise<{
    content?: string;
  }>;
  getModel(): string;
}

interface StubBehavior {
  respond?: (req: { messages: { role: string; content: string }[]; signal?: AbortSignal }) => Promise<{ content?: string }> | { content?: string };
  callCount?: number;
  model?: string;
}

function makeStubClient(behavior: StubBehavior): StubLlmClient {
  return {
    async generate(opts) {
      behavior.callCount = (behavior.callCount ?? 0) + 1;
      if (!behavior.respond) return { content: 'default-stub-response' };
      return behavior.respond(opts);
    },
    getModel: () => behavior.model ?? 'stub-model',
  };
}

// ── Per-test scratch dirs ───────────────────────────────────────────────
let bundleDir: string;
let projectDir: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'llm-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'llm-proj-'));
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  mkdirSync(join(bundleDir, 'schemas'), { recursive: true });
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(opts: {
  config: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  signal?: AbortSignal;
}): RunnerContext {
  const node: NodeDef = {
    id: 'test_node',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'md', pattern: 'output.md' },
    runner: { tool: 'llm.generate', config: opts.config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: opts.inputs ?? {},
    ...(opts.signal ? { signal: opts.signal } : {}),
    log: () => {},
  };
}

// ── Failure mode tests ─────────────────────────────────────────────────

describe('llm.generate runner', () => {
  describe('happy path', () => {
    it('renders prompt template + calls LLM + writes output to outputPath', async () => {
      writeFileSync(join(bundleDir, 'prompts/story.md'), 'Write a story about {{topic}}.');
      const client = makeStubClient({
        respond: async (req) => {
          // Verify the substitution happened before the LLM call.
          expect(req.messages[0]!.content).toContain('Write a story about dragons.');
          return { content: '# A Story\n\nThe dragon flew...' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/story.md',
          outputPath: 'plans/story.md',
          tier: 'heavy',
          outputFormat: 'markdown',
        },
        inputs: { topic: 'dragons' },
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const written = readFileSync(join(projectDir, result.outputPath), 'utf-8');
        expect(written).toBe('# A Story\n\nThe dragon flew...');
      }
    });
  });

  describe('cost accounting (budget cap depends on this)', () => {
    // The walker stamps node.completed.generation.costUsd from
    // result.metadata.costUsd, which computeCostLedger sums and the
    // budget backstop enforces. The runner MUST propagate the provider-
    // reported usage.cost onto its result metadata — not just the
    // telemetry sink — or the cap sees $0 and never trips.
    function usageRespond(content: string, cost?: number) {
      return async () =>
        ({
          content,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            ...(cost !== undefined ? { cost } : {}),
          },
        }) as unknown as { content?: string };
    }

    it('propagates provider usage.cost onto result.metadata.costUsd', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'Write {{topic}}.');
      const client = makeStubClient({ respond: usageRespond('# Out\n\nbody', 0.0123) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });
      const result = await runner.run(
        makeCtx({
          config: { promptTemplate: 'prompts/p.md', outputPath: 'plans/p.md', tier: 'heavy', outputFormat: 'markdown' },
          inputs: { topic: 'x' },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.metadata as { costUsd?: number }).costUsd).toBeCloseTo(0.0123, 6);
      }
    });

    it('omits costUsd when the provider reports no cost (e.g. a local endpoint)', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'Write {{topic}}.');
      const client = makeStubClient({ respond: usageRespond('# Out\n\nbody') }); // no cost
      const runner = createLlmGenerateRunner({ clientFactory: () => client });
      const result = await runner.run(
        makeCtx({
          config: { promptTemplate: 'prompts/p.md', outputPath: 'plans/p.md', tier: 'heavy', outputFormat: 'markdown' },
          inputs: { topic: 'x' },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.metadata as { costUsd?: number }).costUsd).toBeUndefined();
      }
    });

    it('sums cost across retries (a failed empty attempt still cost tokens)', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'Write {{topic}}.');
      let n = 0;
      const client = makeStubClient({
        respond: async () => {
          n += 1;
          // First attempt: empty content (triggers a retry) but still reports cost.
          // Second attempt: real content + cost. Total should be the sum.
          return (n === 1
            ? { content: '', usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100, cost: 0.001 } }
            : { content: '# Out\n\nbody', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: 0.002 } }) as unknown as { content?: string };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });
      const result = await runner.run(
        makeCtx({
          config: { promptTemplate: 'prompts/p.md', outputPath: 'plans/p.md', tier: 'heavy', outputFormat: 'markdown', maxRetries: 2 },
          inputs: { topic: 'x' },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.metadata as { costUsd?: number }).costUsd).toBeCloseTo(0.003, 6);
      }
    });
  });

  // Failure mode #1 — timeout + retry
  describe('timeout / failure retry', () => {
    it('retries up to maxRetries before failing, then returns ok:false', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      let calls = 0;
      const client = makeStubClient({
        respond: async () => {
          calls++;
          throw new Error('simulated timeout');
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
          maxRetries: 2,
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/timeout|simulated/i);
      }
      // 1 initial call + 2 retries = 3 attempts.
      expect(calls).toBe(3);
    });
  });

  // Empty response is transient (model hiccup) — it must be RETRIED,
  // not bailed on the first occurrence.
  describe('empty response retry', () => {
    it('retries an empty response and succeeds when a later attempt returns content', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      let calls = 0;
      const client = makeStubClient({
        respond: async () => {
          calls++;
          // First two attempts return empty; third returns real content.
          return calls < 3 ? { content: '' } : { content: '# Recovered\n\nprose' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
          maxRetries: 2,
        },
      }));

      expect(result.ok).toBe(true);
      expect(calls).toBe(3); // it actually used its attempts instead of bailing on #1
      if (result.ok) {
        expect(readFileSync(join(projectDir, result.outputPath), 'utf-8')).toContain('Recovered');
      }
    });

    it('fails only after exhausting all attempts when every response is empty', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      let calls = 0;
      const client = makeStubClient({
        respond: async () => {
          calls++;
          return { content: '' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
          maxRetries: 2,
        },
      }));

      expect(result.ok).toBe(false);
      expect(calls).toBe(3); // 1 + 2 retries — NOT a single bail
      if (!result.ok) expect(result.error).toMatch(/empty response/i);
    });
  });

  // Failure mode #2 — malformed JSON
  describe('malformed JSON output', () => {
    it('fails clearly with the raw LLM output captured in the error', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'json please');
      const client = makeStubClient({
        respond: async () => ({ content: 'this is not { json at all' }),
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'medium',
          outputFormat: 'json',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Per "be transparent in UI on failure": the user-facing
        // error must say what went wrong (LLM returned malformed JSON)
        // AND capture enough of the raw output to debug.
        expect(result.error).toMatch(/json/i);
        expect(result.error).toMatch(/not \{ json at all/i);
      }
    });
  });

  // Failure mode #3 — JSON schema validation failure
  describe('JSON schema validation', () => {
    it('fails when LLM output is valid JSON but does not match the declared schema', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      writeFileSync(
        join(bundleDir, 'schemas/character.schema.json'),
        JSON.stringify({
          type: 'object',
          required: ['name', 'description'],
          properties: { name: { type: 'string' }, description: { type: 'string' } },
        }),
      );
      const client = makeStubClient({
        respond: async () => ({ content: '{"name": "Naia"}' }), // missing description
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'medium',
          outputFormat: 'json',
          outputSchema: 'schemas/character.schema.json',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/schema|description|required/i);
      }
    });

    it('passes when LLM output validates against the schema', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      writeFileSync(
        join(bundleDir, 'schemas/character.schema.json'),
        JSON.stringify({
          type: 'object',
          required: ['name', 'description'],
          properties: { name: { type: 'string' }, description: { type: 'string' } },
        }),
      );
      const client = makeStubClient({
        respond: async () => ({ content: '{"name": "Naia", "description": "potter"}' }),
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'medium',
          outputFormat: 'json',
          outputSchema: 'schemas/character.schema.json',
        },
      }));

      expect(result.ok).toBe(true);
    });
  });

  // normalizeShotIds — construct canonical scene/shot ids instead of
  // trusting the LLM to format them. Motivated by a real failure: a
  // weak model (deepseek-v4-flash) emitted correct `scene`/`shotNumber`
  // fields but ids with a global counter + sub-shot letters
  // ("scene_2_shot_15a"), failing the strict id pattern in an endless
  // retry loop.
  describe('normalizeShotIds', () => {
    const SCENES_PLAN_SCHEMA = {
      type: 'object',
      required: ['scenes', 'shots'],
      properties: {
        scenes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', pattern: '^scene_[0-9]+$' } },
          },
        },
        shots: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'duration', 'description'],
            properties: {
              id: { type: 'string', pattern: '^scene_[0-9]+_shot_[0-9]+$' },
              scene: { type: 'integer' },
              shotNumber: { type: 'integer' },
              duration: { type: 'integer' },
              description: { type: 'string' },
            },
          },
        },
      },
    };

    // The exact drift that motivated this: `scene` is right, but the id
    // uses a global counter and a sub-shot letter on the last shot.
    const DRIFTED_OUTPUT = JSON.stringify({
      scenes: [
        { id: 'scene_1', title: 'a' },
        { id: 'scene_2', title: 'b' },
      ],
      shots: [
        { id: 'scene_1_shot_1', scene: 1, shotNumber: 1, duration: 3, description: 'x' },
        { id: 'scene_1_shot_2', scene: 1, shotNumber: 2, duration: 3, description: 'x' },
        { id: 'scene_2_shot_3', scene: 2, shotNumber: 1, duration: 3, description: 'x' },
        { id: 'scene_2_shot_15a', scene: 2, shotNumber: 2, duration: 3, description: 'x' },
      ],
    });

    it('pure fn: rebuilds canonical scene_N_shot_M ids from scene + order', () => {
      const v = JSON.parse(DRIFTED_OUTPUT);
      normalizeSceneShotIds(v);
      expect(v.shots.map((s: { id: string }) => s.id)).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
        'scene_2_shot_1',
        'scene_2_shot_2',
      ]);
      // shotNumber reset per scene by order; scene membership preserved.
      expect(v.shots.map((s: { shotNumber: number }) => s.shotNumber)).toEqual([1, 2, 1, 2]);
      expect(v.scenes.map((s: { id: string }) => s.id)).toEqual(['scene_1', 'scene_2']);
    });

    it('pure fn: no-op when there is no top-level shots array', () => {
      const v = { foo: 'bar' };
      normalizeSceneShotIds(v);
      expect(v).toEqual({ foo: 'bar' });
    });

    it('pure fn: derives scene from a drifted id prefix when scene field is absent', () => {
      const v = {
        shots: [
          { id: 'scene_3_shot_99', duration: 3, description: 'x' },
          { id: 'scene_3_shot_zzz', duration: 3, description: 'x' },
        ],
      };
      normalizeSceneShotIds(v);
      expect(v.shots.map((s: { id: string }) => s.id)).toEqual(['scene_3_shot_1', 'scene_3_shot_2']);
    });

    it('runner: drifted ids pass the strict schema when the flag is on', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      writeFileSync(join(bundleDir, 'schemas/scenes.schema.json'), JSON.stringify(SCENES_PLAN_SCHEMA));
      const client = makeStubClient({ respond: async () => ({ content: DRIFTED_OUTPUT }) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'plans/scenes_plan.json',
          tier: 'heavy',
          outputFormat: 'json',
          outputSchema: 'schemas/scenes.schema.json',
          normalizeShotIds: true,
        },
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const written = JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'));
        expect(written.shots.map((s: { id: string }) => s.id)).toEqual([
          'scene_1_shot_1', 'scene_1_shot_2', 'scene_2_shot_1', 'scene_2_shot_2',
        ]);
      }
    });

    it('runner: WITHOUT the flag, the same drifted ids fail the strict schema', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      writeFileSync(join(bundleDir, 'schemas/scenes.schema.json'), JSON.stringify(SCENES_PLAN_SCHEMA));
      const client = makeStubClient({ respond: async () => ({ content: DRIFTED_OUTPUT }) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'plans/scenes_plan.json',
          tier: 'heavy',
          outputFormat: 'json',
          outputSchema: 'schemas/scenes.schema.json',
          maxRetries: 0,
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/pattern|schema/i);
    });
  });

  // Failure mode #4 — prompt template references missing variable
  describe('missing template variable', () => {
    it('fails clearly when prompt template uses an input that was not provided', async () => {
      writeFileSync(
        join(bundleDir, 'prompts/p.md'),
        'Topic: {{topic}} and audience: {{audience}}.',
      );
      const client = makeStubClient({ respond: async () => ({ content: 'unused' }) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
        },
        inputs: { topic: 'dragons' }, // audience missing
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/audience/);
        expect(result.error).toMatch(/missing|not provided|undefined/i);
      }
    });
  });

  // Failure mode #5 — prompt file path doesn't exist
  describe('missing prompt file', () => {
    it('fails clearly when the promptTemplate file does not exist', async () => {
      const client = makeStubClient({ respond: async () => ({ content: 'unused' }) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/nonexistent.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/prompt|not found|nonexistent\.md/i);
      }
    });
  });

  // Failure mode #6 — output exists, forceRerun=false → skip
  describe('skip-if-output-exists', () => {
    it('returns the existing output without calling the LLM when output exists and forceRerun is false', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      mkdirSync(join(projectDir, 'plans'), { recursive: true });
      writeFileSync(join(projectDir, 'plans/cached.md'), 'pre-existing content');

      let calls = 0;
      const client = makeStubClient({
        respond: async () => {
          calls++;
          return { content: 'should not be called' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'plans/cached.md',
          tier: 'medium',
          outputFormat: 'markdown',
        },
      }));

      expect(result.ok).toBe(true);
      expect(calls).toBe(0); // LLM was NOT called
      if (result.ok) {
        const written = readFileSync(join(projectDir, result.outputPath), 'utf-8');
        expect(written).toBe('pre-existing content'); // unchanged
      }
    });

    it('re-runs when forceRerun=true even if output exists', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      mkdirSync(join(projectDir, 'plans'), { recursive: true });
      writeFileSync(join(projectDir, 'plans/cached.md'), 'pre-existing content');

      const client = makeStubClient({
        respond: async () => ({ content: 'fresh content' }),
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'plans/cached.md',
          tier: 'medium',
          outputFormat: 'markdown',
          forceRerun: true,
        },
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(readFileSync(join(projectDir, result.outputPath), 'utf-8')).toBe('fresh content');
      }
    });
  });

  // Failure mode #7 — output exists but is empty/zero bytes
  describe('zero-byte existing output', () => {
    it('treats a zero-byte output file as missing and re-runs', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      mkdirSync(join(projectDir, 'plans'), { recursive: true });
      writeFileSync(join(projectDir, 'plans/empty.md'), ''); // zero bytes

      const client = makeStubClient({
        respond: async () => ({ content: 'real content this time' }),
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'plans/empty.md',
          tier: 'medium',
          outputFormat: 'markdown',
        },
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(readFileSync(join(projectDir, result.outputPath), 'utf-8')).toBe('real content this time');
        expect(statSync(join(projectDir, result.outputPath)).size).toBeGreaterThan(0);
      }
    });
  });

  describe('CAS model identity', () => {
    it('does not reuse a cached LLM output generated by a different model', async () => {
      const priorDisableCas = process.env['DHEE_DISABLE_CAS'];
      const priorCacheRoot = process.env['DHEE_CACHE_ROOT'];
      const cacheRoot = mkdtempSync(join(tmpdir(), 'llm-cas-model-'));
      delete process.env['DHEE_DISABLE_CAS'];
      process.env['DHEE_CACHE_ROOT'] = cacheRoot;

      try {
        writeFileSync(join(bundleDir, 'prompts/p.md'), 'Write about {{topic}}.');

        const glmBehavior: StubBehavior = {
          model: 'glm-local',
          respond: async () => ({ content: 'from GLM' }),
        };
        const qwenBehavior: StubBehavior = {
          model: 'qwen-27b-local',
          respond: async () => ({ content: 'from Qwen' }),
        };
        const glm = makeStubClient(glmBehavior);
        const qwen = makeStubClient(qwenBehavior);
        const config = {
          promptTemplate: 'prompts/p.md',
          outputPath: 'plans/model-aware.md',
          tier: 'medium',
          outputFormat: 'markdown',
        };
        const inputs = { topic: 'cache identity' };

        const r1 = await createLlmGenerateRunner({ clientFactory: () => glm }).run(
          makeCtx({ config, inputs }),
        );
        const r2 = await createLlmGenerateRunner({ clientFactory: () => qwen }).run(
          makeCtx({ config, inputs }),
        );

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(glmBehavior.callCount).toBe(1);
        expect(qwenBehavior.callCount).toBe(1);
        expect(readFileSync(join(projectDir, 'plans/model-aware.md'), 'utf-8')).toBe('from Qwen');
        if (r2.ok) {
          expect(r2.metadata?.['casHit']).toBeUndefined();
          expect(r2.metadata?.['model']).toBe('qwen-27b-local');
        }
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
        if (priorDisableCas === undefined) delete process.env['DHEE_DISABLE_CAS'];
        else process.env['DHEE_DISABLE_CAS'] = priorDisableCas;
        if (priorCacheRoot === undefined) delete process.env['DHEE_CACHE_ROOT'];
        else process.env['DHEE_CACHE_ROOT'] = priorCacheRoot;
      }
    });
  });

  // Failure mode #8 — AbortSignal cancellation
  describe('AbortSignal', () => {
    it('passes the abort signal through to the LLM client and returns ok:false on abort', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      let receivedSignal: AbortSignal | undefined;
      const client = makeStubClient({
        respond: async (req) => {
          receivedSignal = req.signal;
          // Simulate a long call that gets aborted.
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 5000);
            req.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
          return { content: 'never' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const ac = new AbortController();
      const p = runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
        },
        signal: ac.signal,
      }));
      setTimeout(() => ac.abort(), 20);
      const result = await p;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/abort/i);
      expect(receivedSignal).toBeDefined();
    });
  });

  // Failure mode #9 — unknown tier
  describe('config validation', () => {
    it('fails at config validation when tier is unrecognized', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      const client = makeStubClient({ respond: async () => ({ content: 'unused' }) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'ultra', // not a valid tier
          outputFormat: 'markdown',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/tier|ultra/i);
      }
    });
  });

  // BUG-003 regression: ctx.itemId must be exposed as {{item_id}}.
  describe('BUG-003 — ctx.itemId injection', () => {
    it('exposes ctx.itemId as {{item_id}} for collection instances', async () => {
      writeFileSync(
        join(bundleDir, 'prompts/p.md'),
        'Write about shot {{item_id}}. Context: {{scenes_plan}}.',
      );
      let receivedPrompt = '';
      const client = makeStubClient({
        respond: async (req) => {
          receivedPrompt = req.messages[0]!.content;
          return { content: 'result' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });
      const ctx = makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'heavy',
          outputFormat: 'markdown',
        },
        inputs: { scenes_plan: 'JSON-here' },
      });
      // Inject itemId on the constructed context (collection instance).
      (ctx as { itemId?: string }).itemId = 'scene_1_shot_3';

      const result = await runner.run(ctx);
      expect(result.ok).toBe(true);
      expect(receivedPrompt).toContain('Write about shot scene_1_shot_3.');
      expect(receivedPrompt).toContain('Context: JSON-here.');
    });

    it("doesn't overwrite an upstream input that happens to be named 'item_id'", async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), '{{item_id}}');
      let received = '';
      const client = makeStubClient({
        respond: async (req) => {
          received = req.messages[0]!.content;
          return { content: 'x' };
        },
      });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });
      const ctx = makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'heavy',
          outputFormat: 'markdown',
        },
        inputs: { item_id: 'from-input' },
      });
      (ctx as { itemId?: string }).itemId = 'from-ctx';
      await runner.run(ctx);
      // Upstream wins on conflict — precedence is explicit so the bundle
      // author can override via an upstream node that emits item_id.
      expect(received).toBe('from-input');
    });
  });

  // Failure mode #10 — empty LLM response
  describe('empty LLM response', () => {
    it('fails loudly when the LLM returns empty content', async () => {
      writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
      const client = makeStubClient({ respond: async () => ({ content: '' }) });
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'medium',
          outputFormat: 'markdown',
        },
      }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Per "be transparent in UI on failure" project rule: the
        // empty response must surface as such, not as a misleading
        // "could not parse" or silent retry.
        expect(result.error).toMatch(/empty|no content|empty response/i);
      }
    });
  });
});
