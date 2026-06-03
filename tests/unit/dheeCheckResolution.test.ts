/**
 * dhee_check_resolution — flags completed image artifacts whose actual
 * dimensions no longer match the project's target aspect+resolution, so
 * the agent regenerates the stale upstream images (not just the video)
 * on a resolution request. Regression for BUG-028.
 *
 * Behaviour under test:
 *   1. An image rendered at the old long-edge size (720×408) is flagged
 *      stale for a 16:9 @720 target (expected 1280×720).
 *   2. An image already at the target size (1280×720) is NOT flagged.
 *   3. A square reference image (1024×1024) is never flagged (aspect-agnostic).
 *   4. With nothing stale, the tool reports all-clear.
 *   5. Missing project.json / bundle → graceful error, not a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCheckResolutionTool } from '../../src/agent/pi/tools/dheeCheckResolution.js';

let projectDir: string;
let bundlesDir: string;

function writePng(path: string, width: number, height: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const buf = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  writeFileSync(path, buf);
}

function writeBundle(): void {
  mkdirSync(join(bundlesDir, 'test-bundle'), { recursive: true });
  writeFileSync(
    join(bundlesDir, 'test-bundle', 'bundle.json'),
    JSON.stringify({
      id: 'test-bundle',
      version: '0.1.0',
      goal: 'final',
      nodes: [
        { id: 'shot_image', outputs: { format: 'image' }, runner: { tool: 'comfy.image', config: { width: 1920, height: 1080 } } },
        { id: 'character_image', outputs: { format: 'image' }, runner: { tool: 'comfy.image', config: { width: 1024, height: 1024 } } },
      ],
    }),
  );
}

function writeProject(walkNodes: Record<string, unknown>, resolution: number | undefined = 720): void {
  const body: Record<string, unknown> = {
    name: 'X',
    aspect: '16:9',
    bundleSource: 'built-in:test-bundle',
    walkState: { nodes: walkNodes },
  };
  if (resolution !== undefined) body['resolution'] = resolution;
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(body));
}

interface ToolResult {
  content: Array<{ text: string }>;
  details?: { stale?: Array<{ nodeKey: string }>; target?: unknown };
  isError?: boolean;
}
function tool() {
  return makeCheckResolutionTool({ bundlesDir: () => bundlesDir }) as unknown as {
    execute: (id: string, p: { projectDir: string }) => Promise<ToolResult>;
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'checkres-proj-'));
  bundlesDir = mkdtempSync(join(tmpdir(), 'checkres-bundles-'));
  writeBundle();
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(bundlesDir, { recursive: true, force: true });
});

describe('dhee_check_resolution', () => {
  it('1. flags an old long-edge image (720×408) as stale for 16:9 @720', async () => {
    writeProject({
      'shot_image:scene_1_shot_1': { status: 'completed', outputPath: 'assets/images/s1.png' },
    });
    writePng(join(projectDir, 'assets/images/s1.png'), 720, 408);

    const r = await tool().execute('t', { projectDir });
    const stale = r.details?.stale ?? [];
    expect(stale.map((s) => s.nodeKey)).toContain('shot_image:scene_1_shot_1');
    expect(r.content[0]!.text).toMatch(/stale/i);
    // surfaces both the wrong actual and the right expected size
    expect(r.content[0]!.text).toContain('720x408');
    expect(r.content[0]!.text).toContain('1280x720');
  });

  it('2. does NOT flag an image already at the target size (1280×720)', async () => {
    writeProject({
      'shot_image:scene_1_shot_2': { status: 'completed', outputPath: 'assets/images/s2.png' },
    });
    writePng(join(projectDir, 'assets/images/s2.png'), 1280, 720);

    const r = await tool().execute('t', { projectDir });
    expect(r.details?.stale ?? []).toHaveLength(0);
    expect(r.content[0]!.text).toMatch(/match|up to date|nothing/i);
  });

  it('3. never flags a square reference image (aspect-agnostic)', async () => {
    writeProject({
      'character_image:hero': { status: 'completed', outputPath: 'assets/images/hero.png' },
    });
    writePng(join(projectDir, 'assets/images/hero.png'), 1024, 1024);

    const r = await tool().execute('t', { projectDir });
    expect(r.details?.stale ?? []).toHaveLength(0);
  });

  it('4. mixed: flags only the stale image, leaves fresh + square alone', async () => {
    writeProject({
      'shot_image:scene_1_shot_1': { status: 'completed', outputPath: 'assets/images/s1.png' },
      'shot_image:scene_1_shot_2': { status: 'completed', outputPath: 'assets/images/s2.png' },
      'character_image:hero': { status: 'completed', outputPath: 'assets/images/hero.png' },
    });
    writePng(join(projectDir, 'assets/images/s1.png'), 720, 408); // stale
    writePng(join(projectDir, 'assets/images/s2.png'), 1280, 720); // fresh
    writePng(join(projectDir, 'assets/images/hero.png'), 1024, 1024); // square

    const r = await tool().execute('t', { projectDir });
    const keys = (r.details?.stale ?? []).map((s) => s.nodeKey);
    expect(keys).toEqual(['shot_image:scene_1_shot_1']);
  });

  it('5. missing project.json → graceful error, not a throw', async () => {
    const r = await tool().execute('t', { projectDir: join(projectDir, 'does-not-exist') });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not found/i);
  });
});
