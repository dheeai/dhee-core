/**
 * Regression: BUG-005 — stopAt must restrict the run to the ancestor
 * set of the target node, not just the linear topo prefix.
 *
 * Bundle shape (final_video has two independent ancestor chains):
 *
 *           ┌─ A1 → A2 ─┐
 *   leaf →                final_video
 *           └─ B1 → B2 ─┘
 *
 * stopAt=A2 must run only [leaf, A1, A2] — never B1 or B2.
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
import type { DagBundle, Runner } from '../../src/dag/schema.js';

const ran: string[] = [];

function recordingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.rec',
      displayName: 'rec',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      ran.push(ctx.node.id);
      const out = ctx.node.outputs.pattern;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, 'x');
      return { ok: true, outputPath: out };
    },
  };
}

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'stopat-anc-'));
  ran.length = 0;
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.rec', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    recordingRunner(),
  );
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

const TWO_BRANCH_BUNDLE: DagBundle = {
  id: 'tb',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'final_video',
  nodes: [
    { id: 'leaf', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'leaf.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'A1', kind: 'stage', inputs: [{ from: 'leaf', usage: 'context' }], outputs: { format: 'md', pattern: 'a1.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'A2', kind: 'stage', inputs: [{ from: 'A1', usage: 'context' }], outputs: { format: 'md', pattern: 'a2.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'B1', kind: 'stage', inputs: [{ from: 'leaf', usage: 'context' }], outputs: { format: 'md', pattern: 'b1.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'B2', kind: 'stage', inputs: [{ from: 'B1', usage: 'context' }], outputs: { format: 'md', pattern: 'b2.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'final_video', kind: 'stage', inputs: [{ from: 'A2', usage: 'context' }, { from: 'B2', usage: 'context' }], outputs: { format: 'video', pattern: 'final.mp4' }, runner: { tool: 'stub.rec', config: {} } },
  ],
};

describe('BUG-005 — stopAt restricts to ancestor set', () => {
  it('(a) stopAt=A2 runs only [leaf, A1, A2]', async () => {
    const r = await walkBundle({ projectDir, bundle: TWO_BRANCH_BUNDLE, bundleSource: 'built-in:tb', stopAt: 'A2' });
    expect(r.ok).toBe(true);
    expect(ran.sort()).toEqual(['A1', 'A2', 'leaf']);
  });

  it('(b) stopAt=B2 runs only [leaf, B1, B2] — A branch untouched', async () => {
    const r = await walkBundle({ projectDir, bundle: TWO_BRANCH_BUNDLE, bundleSource: 'built-in:tb', stopAt: 'B2' });
    expect(r.ok).toBe(true);
    expect(ran.sort()).toEqual(['B1', 'B2', 'leaf']);
  });

  it('(c) stopAt=final_video runs everything (same as no stopAt)', async () => {
    const r = await walkBundle({ projectDir, bundle: TWO_BRANCH_BUNDLE, bundleSource: 'built-in:tb', stopAt: 'final_video' });
    expect(r.ok).toBe(true);
    expect(ran.sort()).toEqual(['A1', 'A2', 'B1', 'B2', 'final_video', 'leaf']);
  });

  it('(d) stopAt at a root-leaf node runs only that node', async () => {
    const r = await walkBundle({ projectDir, bundle: TWO_BRANCH_BUNDLE, bundleSource: 'built-in:tb', stopAt: 'leaf' });
    expect(r.ok).toBe(true);
    expect(ran).toEqual(['leaf']);
  });
});
