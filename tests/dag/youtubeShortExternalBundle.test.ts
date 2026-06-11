import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { initializeProject } from '../../src/dag/initializeProject.js';
import {
  loadBundle,
  parseBundleSource,
  resolveBundleDir,
  walkBundle,
} from '../../src/dag/walker.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import { ffmpegShotClipRunner } from '../../src/dag/runners/ffmpegShotClip.js';
import { ffmpegConcatRunner } from '../../src/dag/runners/ffmpegConcat.js';

const EXTERNAL_BUNDLE_DIR = resolve(
  __dirname,
  '../../../dhee-packages/youtube-short-bundle/bundle'
);

function llmStub(): Runner {
  return {
    describe: () => ({
      id: 'llm.generate',
      displayName: 'LLM Generate Stub',
      description: 'Writes deterministic YouTube bundle artifacts for tests.',
      capabilities: [],
      modalities: { input: ['text'], output: ['text'] },
      configSchema: {},
    }),
    async run(ctx) {
      const outputPath = String(ctx.node.runner.config['outputPath']);
      const outAbs = join(ctx.projectDir, outputPath);
      mkdirSync(dirname(outAbs), { recursive: true });
      let content: string;
      if (ctx.node.id === 'hook') {
        content =
          '## Hook Line\nThis tiny mistake ruins every Short.\n\n## Opening Image\nA phone screen freezes mid-scroll.\n\n## Promise\nThe ending reveals the fix.';
      } else if (ctx.node.id === 'script') {
        content =
          '## Script\n\n[0:00-0:01] HOOK\nVisual: A frozen phone.\nVoice/Text: "Stop doing this."\n';
      } else if (ctx.node.id === 'scenes_plan') {
        content = JSON.stringify({
          totalDurationSec: 5,
          aspect: '9:16',
          style: 'cinematic_short',
          shots: [1, 2, 3, 4, 5].map(shotNumber => ({
            id: `shot_${shotNumber}`,
            shotNumber,
            startSec: shotNumber - 1,
            duration: 1,
            description: `Fast vertical visual beat ${shotNumber}.`,
            speaker: 'VO',
            dialogue: `Line ${shotNumber}`,
          })),
        });
      } else {
        content = JSON.stringify({
          totalDurationSec: 5,
          shots: [1, 2, 3, 4, 5].map(shotNumber => ({
            shotNumber,
            durationSec: 1,
            imagePrompt: `Vertical phone-friendly image prompt ${shotNumber}.`,
            motionDirective: `Quick camera move ${shotNumber}.`,
            dialogueLine: `VO: Line ${shotNumber}`,
          })),
        });
      }
      writeFileSync(outAbs, content, 'utf8');
      return { ok: true, outputPath };
    },
  };
}

function shrinkVideoNodesForTest(bundle: DagBundle): DagBundle {
  return {
    ...bundle,
    nodes: bundle.nodes.map(node => {
      if (node.runner.tool !== 'ffmpeg.shot_clip') return node;
      return {
        ...node,
        runner: {
          ...node.runner,
          config: {
            ...node.runner.config,
            width: 180,
            height: 320,
            durationSec: 1,
          },
        },
      };
    }),
  };
}

describe('external npm YouTube Short bundle', () => {
  const made: string[] = [];
  const prevUser = process.env['DHEE_USER_BUNDLES_DIR'];
  const prevWatermark = process.env['dhee_WATERMARK'];
  const prevDisableCas = process.env['DHEE_DISABLE_CAS'];

  beforeEach(() => {
    __resetGlobalRegistryForTesting();
    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'llm.generate', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      llmStub()
    );
    reg.register(
      { tool: 'ffmpeg.shot_clip', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      ffmpegShotClipRunner
    );
    reg.register(
      { tool: 'ffmpeg.concat', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      ffmpegConcatRunner
    );
    process.env['dhee_WATERMARK'] = 'off';
    process.env['DHEE_DISABLE_CAS'] = '1';
  });

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (prevUser === undefined) delete process.env['DHEE_USER_BUNDLES_DIR'];
    else process.env['DHEE_USER_BUNDLES_DIR'] = prevUser;
    if (prevWatermark === undefined) delete process.env['dhee_WATERMARK'];
    else process.env['dhee_WATERMARK'] = prevWatermark;
    if (prevDisableCas === undefined) delete process.env['DHEE_DISABLE_CAS'];
    else process.env['DHEE_DISABLE_CAS'] = prevDisableCas;
    __resetGlobalRegistryForTesting();
  });

  it('initializes and runs after being copied into the user bundle directory', async () => {
    expect(existsSync(EXTERNAL_BUNDLE_DIR)).toBe(true);

    const userBundlesRoot = mkdtempSync(join(tmpdir(), 'dhee-user-bundles-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-youtube-short-project-'));
    made.push(userBundlesRoot, projectDir);
    cpSync(EXTERNAL_BUNDLE_DIR, join(userBundlesRoot, 'youtube_short_text_video'), {
      recursive: true,
    });
    process.env['DHEE_USER_BUNDLES_DIR'] = userBundlesRoot;

    const init = initializeProject({
      projectDir,
      name: 'External YouTube Short',
      bundleId: 'youtube_short_text_video',
      bundleSource: 'user:youtube_short_text_video',
      inputs: {
        story_input: 'A creator discovers why their first three seconds are not working.',
      },
    });
    expect(init.ok).toBe(true);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(project.bundleSource).toBe('user:youtube_short_text_video');

    const resolved = resolveBundleDir(parseBundleSource('user:youtube_short_text_video'));
    const loaded = loadBundle(join(resolved, 'bundle.json'));
    const bundle = shrinkVideoNodesForTest(loaded);
    expect(getGlobalRegistry().validateBundle(bundle)).toEqual({ ok: true });

    const result = await walkBundle({
      projectDir,
      bundle,
      bundleSource: 'user:youtube_short_text_video',
      bundleDir: resolved,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(projectDir, 'final/youtube_short.mp4'))).toBe(true);
    expect(statSync(join(projectDir, 'final/youtube_short.mp4')).size).toBeGreaterThan(0);
    expect(readFileSync(join(projectDir, 'assets/subtitles/final.srt'), 'utf8')).toContain(
      'VO: Line 1'
    );
  });
});
