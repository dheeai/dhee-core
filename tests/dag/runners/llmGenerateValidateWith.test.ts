/**
 * `cfg.validateWith` — a bundle-supplied validator that runs on the parsed
 * output and whose complaints are repaired by the existing retry loop.
 *
 * The behaviour that matters is not "it rejects bad output" — the schema check
 * already did that. It is that a CROSS-FIELD rule (one a JSON Schema cannot
 * state) now fails at AUTHORING time, where the model that wrote the document
 * is still in the conversation and can fix it, instead of at render time hours
 * later where nothing can.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLlmGenerateRunner } from '../../../src/dag/runners/llmGenerate.js';
import { clearValidatorCache } from '../../../src/dag/runners/externalValidator.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

let bundleDir: string;
let projectDir: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'vw-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'vw-proj-'));
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  mkdirSync(join(bundleDir, 'validators'), { recursive: true });
  clearValidatorCache();
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Write a validator module into the bundle and return its bundle-relative specifier. */
function writeValidator(name: string, source: string): string {
  // A unique filename per test: Node's ESM loader caches by URL, so reusing a
  // name across tests would silently run the FIRST test's validator.
  const file = `validators/${name}-${Math.random().toString(36).slice(2)}.mjs`;
  writeFileSync(join(bundleDir, file), source);
  return `./${file}`;
}

function makeCtx(config: Record<string, unknown>, itemId?: string): RunnerContext {
  const node: NodeDef = {
    id: 'scene_video_prompt',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'json', pattern: 'out.json' },
    runner: { tool: 'llm.generate', config },
  };
  return {
    projectDir,
    bundleDir,
    node,
    inputs: {},
    ...(itemId ? { itemId } : {}),
    log: () => {},
  };
}

function stubClient(responses: string[]) {
  const seen: { messages: { role: string; content: string }[] }[] = [];
  let i = 0;
  return {
    seen,
    client: {
      async generate(opts: { messages: { role: string; content: string }[] }) {
        seen.push({ messages: opts.messages.map((m) => ({ ...m })) });
        return { content: responses[Math.min(i++, responses.length - 1)]! };
      },
      getModel: () => 'stub-model',
    },
  };
}

const BASE_CONFIG = {
  promptTemplate: 'prompts/p.md',
  outputPath: 'out.json',
  outputFormat: 'json',
  tier: 'medium',
};

function writePrompt() {
  writeFileSync(join(bundleDir, 'prompts/p.md'), 'Emit the JSON.');
}

describe('llm.generate cfg.validateWith', () => {
  it('feeds a cross-field complaint back to the model and accepts the repair', async () => {
    writePrompt();
    // The rule a JSON Schema cannot state: shot 1 must start after shot 0 ends.
    const validateWith = writeValidator('ordering', `
      export function validate(value) {
        const shots = value.shots ?? [];
        for (let i = 1; i < shots.length; i++) {
          if (shots[i].startTime < shots[i - 1].endTime) {
            return \`shots[\${i}].startTime (\${shots[i].startTime}) must be >= shots[\${i - 1}].endTime (\${shots[i - 1].endTime}).\`;
          }
        }
      }
    `);
    const bad = JSON.stringify({ shots: [{ startTime: 0, endTime: 5 }, { startTime: 3, endTime: 8 }] });
    const good = JSON.stringify({ shots: [{ startTime: 0, endTime: 5 }, { startTime: 5, endTime: 8 }] });
    const { client, seen } = stubClient([bad, good]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith }));

    expect(result.ok).toBe(true);
    // Two calls: the rejected draft, then the repair.
    expect(seen).toHaveLength(2);
    // The SECOND call must carry the complaint, in words the model can act on.
    const feedback = seen[1]!.messages.map((m) => m.content).join('\n');
    expect(feedback).toContain('shots[1].startTime (3) must be >= shots[0].endTime (5)');
  });

  it('fails the node when the validator never passes, surfacing the complaint', async () => {
    writePrompt();
    const validateWith = writeValidator('always', `
      export function validate() { return 'duration must be between 5 and 15 seconds.'; }
    `);
    const { client, seen } = stubClient([JSON.stringify({ duration: 90 })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith, maxRetries: 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('duration must be between 5 and 15 seconds');
    expect(seen).toHaveLength(2); // initial + one retry
  });

  it('treats a THROWN assertion as a complaint, so a render-time validator can be reused verbatim', async () => {
    writePrompt();
    // Exactly the shape dhee-runner-minimax-h3's validators are already written in.
    const validateWith = writeValidator('throwing', `
      export function validate(value) {
        if (!value.references?.length) throw new Error('references must contain between 1 and 9 entries');
      }
    `);
    const { client } = stubClient([JSON.stringify({ references: [] })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith, maxRetries: 0 }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('references must contain between 1 and 9 entries');
  });

  it('joins multiple complaints so one retry can fix them all', async () => {
    writePrompt();
    const validateWith = writeValidator('many', `
      export function validate() { return ['first shot must start at 0 seconds', 'multi_cut scenes require at least two shots']; }
    `);
    const { client } = stubClient([JSON.stringify({ ok: false })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith, maxRetries: 0 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('first shot must start at 0 seconds');
      expect(result.error).toContain('multi_cut scenes require at least two shots');
    }
  });

  it('passes the item and paths through, so a validator can read a sibling artifact', async () => {
    writePrompt();
    const validateWith = writeValidator('info', `
      export function validate(value, info) {
        if (info.itemId !== 'scene_4') return 'wrong itemId: ' + info.itemId;
        if (info.nodeId !== 'scene_video_prompt') return 'wrong nodeId: ' + info.nodeId;
        if (!info.bundleDir || !info.projectDir) return 'missing dirs';
      }
    `);
    const { client } = stubClient([JSON.stringify({ ok: true })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith }, 'scene_4'));

    expect(result.ok).toBe(true);
  });

  it('rejects a missing validator BEFORE spending a generation', async () => {
    writePrompt();
    const { client, seen } = stubClient([JSON.stringify({ ok: true })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith: './validators/nope.mjs' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('cannot import');
    // The whole point of loading up-front: no tokens burned on output that
    // would have been judged by a validator that does not exist.
    expect(seen).toHaveLength(0);
  });

  it('rejects a module that does not export validate, naming what it did export', async () => {
    writePrompt();
    const validateWith = writeValidator('wrong-shape', `export const notValidate = () => {};`);
    const { client } = stubClient([JSON.stringify({ ok: true })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('must export a `validate` function');
      expect(result.error).toContain('notValidate');
    }
  });

  it('treats a bare specifier as a package, not as a bundle path', async () => {
    writePrompt();
    const { client } = stubClient([JSON.stringify({ ok: true })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG, validateWith: 'dhee-runner-does-not-exist' }));

    expect(result.ok).toBe(false);
    // The package form is the one that lets a runner ship the validator it also
    // enforces at render time, so its failure must say so rather than print a
    // confusing bundle-relative path.
    if (!result.ok) expect(result.error).toContain('package specifier');
  });

  it('is inert when unset — no behaviour change for every existing bundle', async () => {
    writePrompt();
    const { client } = stubClient([JSON.stringify({ anything: 'goes' })]);

    const runner = createLlmGenerateRunner({ clientFactory: () => client });
    const result = await runner.run(makeCtx({ ...BASE_CONFIG }));

    expect(result.ok).toBe(true);
  });
});
