/**
 * Aspect flow — the walker reads project.json's aspect (resolved via
 * the bundle's declared `aspect` project input) and rewrites every
 * node's runner config width+height before invoking the runner.
 *
 * Failure modes covered:
 *   1. project aspect "9:16" + bundle declares 1920x1080
 *      → runner sees 1080x1920 (swapped).
 *   2. project aspect "16:9" (default) leaves dimensions unchanged.
 *   3. Square config dimensions (1024x1024) stay square even on 9:16.
 *   4. Bundle without declared `aspect` input → no transform applied
 *      (back-compat with legacy bundles).
 *   5. project aspect "21:9" produces wider canvas (long edge held,
 *      short edge rounded to mult of 8).
 *   6. Runner whose config has no width/height is untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';

let projectDir: string;
let capturedConfig: Record<string, unknown> | null = null;

function makeCapturingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.dims',
      displayName: 'dims',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      capturedConfig = { ...ctx.node.runner.config };
      const outPath = ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, outPath);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, JSON.stringify(capturedConfig));
      return { ok: true, outputPath: outPath };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-aspect-'));
  capturedConfig = null;
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.dims', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeCapturingRunner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

function makeBundle(
  config: Record<string, unknown>,
  inputs?: DagBundle['inputs'],
): DagBundle {
  return {
    id: 'aspect-test',
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
        runner: { tool: 'stub.dims', config },
      },
    ],
  };
}

function writeProject(aspect: string | undefined): void {
  const body: Record<string, unknown> = {
    name: 'X',
    bundleSource: 'built-in:aspect-test',
  };
  if (aspect !== undefined) body['aspect'] = aspect;
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(body));
}

describe('walker applies aspect to runner config dimensions', () => {
  it('1. 9:16 swaps 1920x1080 → 1080x1920 in the runner config', async () => {
    writeProject('9:16');
    await walkBundle({
      projectDir,
      bundle: makeBundle(
        { width: 1920, height: 1080 },
        [{ id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' }],
      ),
    });
    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!['width']).toBe(1080);
    expect(capturedConfig!['height']).toBe(1920);
  });

  it('2. 16:9 leaves 1920x1080 unchanged', async () => {
    writeProject('16:9');
    await walkBundle({
      projectDir,
      bundle: makeBundle(
        { width: 1920, height: 1080 },
        [{ id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' }],
      ),
    });
    expect(capturedConfig!['width']).toBe(1920);
    expect(capturedConfig!['height']).toBe(1080);
  });

  it('3. square 1024x1024 stays square on 9:16', async () => {
    writeProject('9:16');
    await walkBundle({
      projectDir,
      bundle: makeBundle(
        { width: 1024, height: 1024 },
        [{ id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' }],
      ),
    });
    expect(capturedConfig!['width']).toBe(1024);
    expect(capturedConfig!['height']).toBe(1024);
  });

  it('4. bundle without declared `aspect` input → no transform (legacy)', async () => {
    writeProject('9:16'); // ignored — bundle doesn't declare aspect
    await walkBundle({
      projectDir,
      bundle: makeBundle({ width: 1920, height: 1080 }), // no inputs[]
    });
    expect(capturedConfig!['width']).toBe(1920);
    expect(capturedConfig!['height']).toBe(1080);
  });

  it('5. 21:9 keeps long edge, shrinks short to nearest mult of 8', async () => {
    writeProject('21:9');
    await walkBundle({
      projectDir,
      bundle: makeBundle(
        { width: 1920, height: 1080 },
        [{ id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' }],
      ),
    });
    // 1920 * 9 / 21 = 822.857 → rounds to 824
    expect(capturedConfig!['width']).toBe(1920);
    expect(capturedConfig!['height']).toBe(824);
  });

  it('6. config without width/height stays untouched', async () => {
    writeProject('9:16');
    await walkBundle({
      projectDir,
      bundle: makeBundle(
        { workflowPath: 'foo.json', tier: 'heavy' },
        [{ id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' }],
      ),
    });
    expect(capturedConfig!['workflowPath']).toBe('foo.json');
    expect(capturedConfig!['width']).toBeUndefined();
    expect(capturedConfig!['height']).toBeUndefined();
  });

  // ── Resolution flows through alongside aspect ─────────────────────

  it('7. 16:9 + resolution=720 → 1280x720 (true 720p, short edge)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name: 'X',
        bundleSource: 'built-in:aspect-test',
        aspect: '16:9',
        resolution: 720,
      }),
    );
    await walkBundle({
      projectDir,
      bundle: makeBundle({ width: 1920, height: 1080 }, [
        { id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' },
        { id: 'resolution', kind: 'project', field: 'resolution', default: 1080 },
      ]),
    });
    expect(capturedConfig!['width']).toBe(1280);
    expect(capturedConfig!['height']).toBe(720);
  });

  it('8. 9:16 + resolution=720 → portrait 720x1280 (true 720p)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name: 'X',
        bundleSource: 'built-in:aspect-test',
        aspect: '9:16',
        resolution: 720,
      }),
    );
    await walkBundle({
      projectDir,
      bundle: makeBundle({ width: 1920, height: 1080 }, [
        { id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' },
        { id: 'resolution', kind: 'project', field: 'resolution', default: 1080 },
      ]),
    });
    expect(capturedConfig!['width']).toBe(720);
    expect(capturedConfig!['height']).toBe(1280);
  });

  it('9. resolution caps at bundle baseline (LTX-shape 854 with user 1080 → 854)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name: 'X',
        bundleSource: 'built-in:aspect-test',
        aspect: '16:9',
        resolution: 1080,
      }),
    );
    await walkBundle({
      projectDir,
      bundle: makeBundle({ width: 854, height: 480 }, [
        { id: 'aspect', kind: 'project', field: 'aspect', default: '16:9' },
        { id: 'resolution', kind: 'project', field: 'resolution', default: 1080 },
      ]),
    });
    expect(capturedConfig!['width']).toBe(854);
    expect(capturedConfig!['height']).toBe(480);
  });
});
