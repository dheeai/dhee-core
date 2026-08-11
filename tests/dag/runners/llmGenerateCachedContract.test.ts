/**
 * A CACHED artifact is held to the same id contract as a generated one.
 *
 * Both cache paths — the on-disk skip and the CAS hit — used to return an
 * artifact without running any per-item check, because those live in the
 * generation loop. That makes a validation fix unreachable on the very project
 * that motivated it: the run that would catch the defect never calls the model,
 * so the same bad document comes back forever and a user re-running gets a
 * byte-identical failure with no way to break the cycle.
 *
 * Measured 2026-08-09: a scene staged an id its own `references[]` never
 * declared, `requireDeclared` was added to catch exactly that, the node was
 * reset and re-run — and `CAS hit 4e68104d` replayed the identical file. Only
 * deleting the cache entry by hand let the node execute again.
 *
 * These tests use the on-disk skip path, which needs no cache store: with
 * DHEE_DISABLE_CAS=1 the runner trusts a file already sitting at outputPath.
 * That is the same early return, gated by the same helper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLlmGenerateRunner } from '../../../src/dag/runners/llmGenerate.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

const SCHEMA = {
  type: 'object',
  required: ['references', 'shots'],
  properties: {
    references: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' } } } },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: { sceneryIds: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
};

/** references[] omits `the_deep_quarries`, which shot 0 stages. */
const UNDECLARED = {
  references: [{ id: 'sereth_vale', type: 'character' }],
  shots: [{ sceneryIds: ['the_deep_quarries'] }],
};

const CLEAN = {
  references: [{ id: 'sereth_vale', type: 'character' }, { id: 'the_deep_quarries', type: 'location' }],
  shots: [{ sceneryIds: ['the_deep_quarries'] }],
};

const PER_ITEM = {
  from: 'scenes_plan',
  itemsKey: 'sections',
  matchField: 'id',
  valuesField: 'entities',
  idPaths: ['references[].id', 'shots[].sceneryIds[]'],
  requireDeclared: { paths: ['shots[].sceneryIds[]'], declaredPath: 'references[].id' },
};

const PLAN = { sections: [{ id: 'scene_7', entities: ['sereth_vale', 'the_deep_quarries'] }] };

let bundleDir: string;
let projectDir: string;
let prevCasFlag: string | undefined;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'cached-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'cached-proj-'));
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  mkdirSync(join(bundleDir, 'schemas'), { recursive: true });
  writeFileSync(join(bundleDir, 'prompts/p.md'), 'author the scene');
  writeFileSync(join(bundleDir, 'schemas/scene.schema.json'), JSON.stringify(SCHEMA));
  prevCasFlag = process.env['DHEE_DISABLE_CAS'];
  process.env['DHEE_DISABLE_CAS'] = '1';
});

afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  if (prevCasFlag === undefined) delete process.env['DHEE_DISABLE_CAS'];
  else process.env['DHEE_DISABLE_CAS'] = prevCasFlag;
});

function makeCtx(): RunnerContext {
  const node: NodeDef = {
    id: 'scene_video_prompt',
    kind: 'collection',
    inputs: [],
    outputs: { format: 'json', pattern: 'scene.json' },
    runner: {
      tool: 'llm.generate',
      config: {
        promptTemplate: 'prompts/p.md',
        outputPath: 'scene.json',
        outputSchema: 'schemas/scene.schema.json',
        outputFormat: 'json',
        structuredMode: 'schema',
        tier: 'heavy',
        perItemEnums: PER_ITEM,
      },
    },
  };
  return {
    projectDir,
    bundleDir,
    node,
    itemId: 'scene_7',
    inputs: { scenes_plan: PLAN },
    log: () => {},
  } as RunnerContext;
}

function stubClient(content: string, calls: { n: number }) {
  return {
    async generate() {
      calls.n += 1;
      return { content };
    },
    getModel: () => 'stub-model',
  };
}

describe('llm.generate — a cached artifact must still satisfy the id contract', () => {
  it('regenerates when the cached file stages an id it never declares', async () => {
    // Poison the output the way CAS did: a document that passes the schema and
    // the allowlist, and fails only the document-internal contract.
    writeFileSync(join(projectDir, 'scene.json'), JSON.stringify(UNDECLARED));
    const calls = { n: 0 };
    const runner = createLlmGenerateRunner({ clientFactory: () => stubClient(JSON.stringify(CLEAN), calls) as never });

    const result = await runner.run(makeCtx());

    expect(result.ok).toBe(true);
    // The whole point: the cache was NOT trusted, so the model was called.
    expect(calls.n).toBe(1);
    expect(result.ok && result.metadata?.['cached']).not.toBe(true);
    const written = JSON.parse(readFileSync(join(projectDir, 'scene.json'), 'utf-8'));
    expect(written.references.map((r: { id: string }) => r.id)).toContain('the_deep_quarries');
  });

  it('still trusts a cached file that satisfies the contract — no model call', async () => {
    writeFileSync(join(projectDir, 'scene.json'), JSON.stringify(CLEAN));
    const calls = { n: 0 };
    const runner = createLlmGenerateRunner({ clientFactory: () => stubClient('{}', calls) as never });

    const result = await runner.run(makeCtx());

    expect(result.ok).toBe(true);
    expect(result.ok && result.metadata?.['cached']).toBe(true);
    expect(calls.n).toBe(0);
  });

  it('leaves a node with no perItemEnums alone — the cache is trusted as before', async () => {
    writeFileSync(join(projectDir, 'scene.json'), JSON.stringify(UNDECLARED));
    const calls = { n: 0 };
    const ctx = makeCtx();
    delete (ctx.node.runner!.config as Record<string, unknown>)['perItemEnums'];
    const runner = createLlmGenerateRunner({ clientFactory: () => stubClient('{}', calls) as never });

    const result = await runner.run(ctx);

    expect(result.ok).toBe(true);
    expect(result.ok && result.metadata?.['cached']).toBe(true);
    expect(calls.n).toBe(0);
  });
});

describe('a section that licenses nothing must not block the film', () => {
  it('authors unconstrained instead of failing the node', async () => {
    // A 39-section film died on scene_21 — an establishing beat of sunlight on a
    // milestone, with entities: []. Absence of a list means "cannot constrain",
    // not "must fail"; hard-failing is the getting-stuck this exists to prevent.
    const calls = { n: 0 };
    const ctx = makeCtx();
    (ctx as { inputs: Record<string, unknown> }).inputs = {
      scenes_plan: { sections: [{ id: 'scene_7', entities: [] }] },
    };
    const runner = createLlmGenerateRunner({
      clientFactory: () => stubClient(JSON.stringify(CLEAN), calls) as never,
    });

    const result = await runner.run(ctx);

    expect(result.ok).toBe(true);
    expect(calls.n).toBe(1);
  });

  it('also survives a section that is missing from the plan entirely', async () => {
    const calls = { n: 0 };
    const ctx = makeCtx();
    (ctx as { inputs: Record<string, unknown> }).inputs = {
      scenes_plan: { sections: [{ id: 'scene_99', entities: ['sereth_vale'] }] },
    };
    const runner = createLlmGenerateRunner({
      clientFactory: () => stubClient(JSON.stringify(CLEAN), calls) as never,
    });

    const result = await runner.run(ctx);

    expect(result.ok).toBe(true);
    expect(calls.n).toBe(1);
  });
});
