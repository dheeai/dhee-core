/**
 * Layer 1 — grammar-constrained structured output in `llm.generate`.
 *
 * When `config.outputFormat==='json'` AND `config.outputSchema` is set,
 * the runner should send the parsed schema as
 * `response_format:{type:'json_schema', json_schema:{name, strict, schema}}`
 * instead of the old `{type:'json_object'}` — so providers that support
 * grammar-constrained decoding (llama.cpp GBNF, OpenAI structured outputs)
 * can guarantee schema-conforming output instead of merely "valid JSON".
 *
 * `config.structuredMode` ('auto' default | 'object' | 'schema') and
 * `config.structuredStrict` let a bundle author opt out, and control the
 * OpenAI-style `strict` flag. A provider that rejects `response_format:
 * json_schema` with a 4xx must fall back to `json_object` for THAT call
 * and cache the decision per client (baseUrl|model) so subsequent calls
 * to the same endpoint/model skip straight to json_object.
 *
 * ajv post-validation, the cache-breakpoint split, and the retry loop
 * are all unaffected — this only changes what's sent as `response_format`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLlmGenerateRunner,
  __resetStructuredOutputFallbackCacheForTesting,
} from '../../../src/dag/runners/llmGenerate.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

interface CapturedRequest {
  messages: { role: string; content: string }[];
  responseFormat?: unknown;
}

interface StubBehavior {
  respond?: (req: CapturedRequest) => Promise<{ content?: string }> | { content?: string };
  model?: string;
  baseUrl?: string;
  requests?: CapturedRequest[];
}

interface StubLlmClient {
  generate(opts: {
    messages: { role: string; content: string }[];
    signal?: AbortSignal;
    responseFormat?: unknown;
  }): Promise<{ content?: string }>;
  getModel(): string;
  getBaseUrl?(): string;
}

function makeStubClient(behavior: StubBehavior): StubLlmClient {
  behavior.requests = behavior.requests ?? [];
  const client: StubLlmClient = {
    async generate(opts) {
      const captured: CapturedRequest = { messages: opts.messages, responseFormat: opts.responseFormat };
      behavior.requests!.push(captured);
      if (!behavior.respond) return { content: '{}' };
      return behavior.respond(captured);
    },
    getModel: () => behavior.model ?? 'stub-model',
  };
  if (behavior.baseUrl !== undefined) {
    client.getBaseUrl = () => behavior.baseUrl!;
  }
  return client;
}

/** A provider error that looks like an OpenAI-compatible 4xx complaining about response_format/json_schema. */
class StructuredOutputRejectedError extends Error {
  status: number;
  constructor(message: string) {
    super(message);
    this.status = 400;
  }
}

let bundleDir: string;
let projectDir: string;

const SCHEMA_WITH_OPTIONAL_FIELD = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    note: { type: 'string' },
  },
};

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'structured-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'structured-proj-'));
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  mkdirSync(join(bundleDir, 'schemas'), { recursive: true });
  writeFileSync(join(bundleDir, 'prompts/p.md'), 'go');
  writeFileSync(join(bundleDir, 'schemas/thing.schema.json'), JSON.stringify(SCHEMA_WITH_OPTIONAL_FIELD));
  __resetStructuredOutputFallbackCacheForTesting();
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  __resetStructuredOutputFallbackCacheForTesting();
});

function makeCtx(opts: { nodeId?: string; config: Record<string, unknown> }): RunnerContext {
  const node: NodeDef = {
    id: opts.nodeId ?? 'test_node',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'json', pattern: 'output.json' },
    runner: { tool: 'llm.generate', config: opts.config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: {},
    log: () => {},
  };
}

describe('llm.generate — structured (json_schema) output', () => {
  it("mode 'auto' (default) with outputSchema set → sends response_format.type='json_schema' with the parsed schema + a derived name", async () => {
    const behavior: StubBehavior = { respond: () => ({ content: '{"name": "Naia"}' }) };
    const client = makeStubClient(behavior);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    const result = await runner.run(
      makeCtx({
        nodeId: 'my_node',
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'heavy',
          outputFormat: 'json',
          outputSchema: 'schemas/thing.schema.json',
        },
      }),
    );

    expect(result.ok).toBe(true);
    const req = behavior.requests![0]!;
    const rf = req.responseFormat as { type: string; json_schema?: { name?: string; schema?: unknown; strict?: boolean } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema?.schema).toEqual(SCHEMA_WITH_OPTIONAL_FIELD);
    expect(rf.json_schema?.name).toBeTruthy();
    expect(rf.json_schema?.name).toMatch(/my_node/);
  });

  it("structuredMode:'object' keeps the old {type:'json_object'} behavior even with outputSchema set", async () => {
    const behavior: StubBehavior = { respond: () => ({ content: '{"name": "Naia"}' }) };
    const client = makeStubClient(behavior);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    const result = await runner.run(
      makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'heavy',
          outputFormat: 'json',
          outputSchema: 'schemas/thing.schema.json',
          structuredMode: 'object',
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(behavior.requests![0]!.responseFormat).toEqual({ type: 'json_object' });
  });

  it('respects an explicit structuredStrict value on the json_schema request', async () => {
    const behavior: StubBehavior = { respond: () => ({ content: '{"name": "Naia"}' }) };
    const client = makeStubClient(behavior);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    await runner.run(
      makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'heavy',
          outputFormat: 'json',
          outputSchema: 'schemas/thing.schema.json',
          structuredStrict: true,
        },
      }),
    );

    const rf = behavior.requests![0]!.responseFormat as { json_schema?: { strict?: boolean } };
    expect(rf.json_schema?.strict).toBe(true);
  });

  it('still runs ajv post-validation on json_schema-mode output (fails on schema mismatch)', async () => {
    const behavior: StubBehavior = { respond: () => ({ content: '{"note": "missing the required name field"}' }) };
    const client = makeStubClient(behavior);
    const runner = createLlmGenerateRunner({ clientFactory: () => client });

    const result = await runner.run(
      makeCtx({
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.json',
          tier: 'heavy',
          outputFormat: 'json',
          outputSchema: 'schemas/thing.schema.json',
          maxRetries: 0,
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schema|name|required/i);
  });

  describe('graceful fallback on a provider that rejects response_format:json_schema', () => {
    it('retries the SAME call with json_object on a 4xx structured-output-unsupported error, and succeeds', async () => {
      let call = 0;
      const behavior: StubBehavior = {
        model: 'flaky-model',
        baseUrl: 'https://openrouter.example/v1',
        respond: (req) => {
          call++;
          const rf = req.responseFormat as { type?: string } | undefined;
          if (rf?.type === 'json_schema') {
            throw new StructuredOutputRejectedError(
              '400 This model does not support response_format: json_schema (structured outputs).',
            );
          }
          return { content: '{"name": "Naia"}' };
        },
      };
      const client = makeStubClient(behavior);
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(
        makeCtx({
          config: {
            promptTemplate: 'prompts/p.md',
            outputPath: 'out.json',
            tier: 'heavy',
            outputFormat: 'json',
            outputSchema: 'schemas/thing.schema.json',
            maxRetries: 0, // the fallback retry must NOT consume the retry budget
          },
        }),
      );

      expect(result.ok).toBe(true);
      expect(call).toBe(2); // first attempt (json_schema, rejected) + fallback attempt (json_object)
      expect(behavior.requests![0]!.responseFormat).toMatchObject({ type: 'json_schema' });
      expect(behavior.requests![1]!.responseFormat).toEqual({ type: 'json_object' });
      if (result.ok) {
        expect(JSON.parse(readFileSync(join(projectDir, result.outputPath), 'utf-8'))).toEqual({ name: 'Naia' });
      }
    });

    it('caches the fallback decision per client (baseUrl|model): the next call for the same client goes straight to json_object', async () => {
      let call = 0;
      const behavior: StubBehavior = {
        model: 'flaky-model',
        baseUrl: 'https://openrouter.example/v1',
        respond: (req) => {
          call++;
          const rf = req.responseFormat as { type?: string } | undefined;
          if (rf?.type === 'json_schema') {
            throw new StructuredOutputRejectedError('400 response_format json_schema not supported');
          }
          return { content: '{"name": "Naia"}' };
        },
      };
      const client = makeStubClient(behavior);
      const runnerFactory = () => createLlmGenerateRunner({ clientFactory: () => client });

      const firstResult = await runnerFactory().run(
        makeCtx({
          nodeId: 'node_a',
          config: {
            promptTemplate: 'prompts/p.md',
            outputPath: 'out1.json',
            tier: 'heavy',
            outputFormat: 'json',
            outputSchema: 'schemas/thing.schema.json',
          },
        }),
      );
      expect(firstResult.ok).toBe(true);
      expect(behavior.requests).toHaveLength(2); // schema attempt (rejected) + object fallback

      // Second call, same client (baseUrl|model) — should go straight to
      // json_object, no wasted json_schema attempt.
      const secondResult = await runnerFactory().run(
        makeCtx({
          nodeId: 'node_b',
          config: {
            promptTemplate: 'prompts/p.md',
            outputPath: 'out2.json',
            tier: 'heavy',
            outputFormat: 'json',
            outputSchema: 'schemas/thing.schema.json',
          },
        }),
      );
      expect(secondResult.ok).toBe(true);
      expect(behavior.requests).toHaveLength(3); // exactly ONE new call, straight to json_object
      expect(behavior.requests![2]!.responseFormat).toEqual({ type: 'json_object' });
    });

    it('does not treat an unrelated 4xx (e.g. auth failure) as a structured-output rejection', async () => {
      const behavior: StubBehavior = {
        respond: (req) => {
          const rf = req.responseFormat as { type?: string } | undefined;
          if (rf?.type === 'json_schema') {
            const err = new Error('401 Unauthorized: invalid API key');
            (err as Error & { status?: number }).status = 401;
            throw err;
          }
          return { content: '{"name": "Naia"}' };
        },
      };
      const client = makeStubClient(behavior);
      const runner = createLlmGenerateRunner({ clientFactory: () => client });

      const result = await runner.run(
        makeCtx({
          config: {
            promptTemplate: 'prompts/p.md',
            outputPath: 'out.json',
            tier: 'heavy',
            outputFormat: 'json',
            outputSchema: 'schemas/thing.schema.json',
            maxRetries: 0,
          },
        }),
      );

      // An unrelated auth error must NOT be silently swallowed by the
      // structured-output fallback — it should fail normally.
      expect(result.ok).toBe(false);
      expect(behavior.requests).toHaveLength(1);
    });
  });
});
