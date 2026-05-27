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

import { createLlmGenerateRunner } from '../../../src/dag/runners/llmGenerate.js';
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
}

function makeStubClient(behavior: StubBehavior): StubLlmClient {
  return {
    async generate(opts) {
      behavior.callCount = (behavior.callCount ?? 0) + 1;
      if (!behavior.respond) return { content: 'default-stub-response' };
      return behavior.respond(opts);
    },
    getModel: () => 'stub-model',
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
