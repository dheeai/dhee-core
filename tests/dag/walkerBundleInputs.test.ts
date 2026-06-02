/**
 * Regression: BUG-004 — walker resolves bundle.inputs[] into a
 * per-walk map merged into every node's ctx.inputs.
 *
 * Tests cover the 6 manifestations enumerated in docs/bugs.md BUG-004:
 *   (a) file kind, file present → resolved
 *   (b) file kind, file missing, required=false → silently absent
 *   (c) file kind, file missing, required=true → error names file
 *   (d) project kind, field present → resolved
 *   (e) project kind, field missing + default → uses default
 *   (f) project kind, field missing + no default + required → error
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

let projectDir: string;
let lastSeenInputs: Record<string, unknown> = {};

function makeCapturingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.capture',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      lastSeenInputs = ctx.inputs;
      const outPath = ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, outPath);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, JSON.stringify(ctx.inputs));
      return { ok: true, outputPath: outPath };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bundle-inputs-'));
  lastSeenInputs = {};
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.capture', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeCapturingRunner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

function makeBundle(inputs: DagBundle['inputs']): DagBundle {
  return {
    id: 'bi-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'leaf',
    ...(inputs ? { inputs } : {}),
    nodes: [
      {
        id: 'leaf',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'leaf.json' },
        runner: { tool: 'stub.capture', config: {} },
      },
    ],
  };
}

describe('BUG-004 — bundle input resolution', () => {
  it('(a) file kind, file present → resolved as string', async () => {
    mkdirSync(join(projectDir, 'inputs'), { recursive: true });
    writeFileSync(join(projectDir, 'inputs/story.md'), 'Once upon a time...');
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'story_input', kind: 'file', path: 'inputs/story.md', required: true },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(true);
    expect(lastSeenInputs['story_input']).toBe('Once upon a time...');
  });

  it('(b) file kind, file missing, required=false → silently absent', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'story_input', kind: 'file', path: 'inputs/optional.md', required: false },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(true);
    expect(lastSeenInputs['story_input']).toBeUndefined();
  });

  it('(c) file kind, file missing, required=true → error names the file', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'story_input', kind: 'file', path: 'inputs/required.md', required: true },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/inputs\/required\.md|story_input/);
    }
  });

  it('(d) project kind, field present → resolved', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', targetDuration: 25, style: 'cinematic_realism' }),
    );
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'targetDuration', kind: 'project', field: 'targetDuration' },
        { id: 'style', kind: 'project', field: 'style' },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(true);
    expect(lastSeenInputs['targetDuration']).toBe(25);
    expect(lastSeenInputs['style']).toBe('cinematic_realism');
  });

  it('(e) project kind, field missing + default → uses default', async () => {
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'p' }));
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'targetDuration', kind: 'project', field: 'targetDuration', default: 30 },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(true);
    expect(lastSeenInputs['targetDuration']).toBe(30);
  });

  it('(f) project kind, field missing + no default + required → error', async () => {
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'p' }));
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'targetDuration', kind: 'project', field: 'targetDuration', required: true },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/targetDuration|project\.json/);
    }
  });

  it('supports dot-path field access (e.g. goal.targetDuration)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', goal: { targetDuration: 22 } }),
    );
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle([
        { id: 'targetDuration', kind: 'project', field: 'goal.targetDuration' },
      ]),
      bundleSource: 'built-in:bi-test',
    });
    expect(result.ok).toBe(true);
    expect(lastSeenInputs['targetDuration']).toBe(22);
  });
});
