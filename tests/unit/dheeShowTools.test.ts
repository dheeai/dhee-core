/**
 * dhee_show_node_output + dhee_show_file — Phase 6.5c
 *
 * Cover the load-bearing happy paths and the most common failure
 * modes for both inline-display tools.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeShowFileTool,
  makeShowNodeOutputTool,
} from '../../src/agent/pi/tools/index.js';

const ctx = {} as never;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kshana-show-tools-'));
});
afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('dhee_show_node_output', () => {
  function projectWithAsset(name: string, nodeKey: string, rel: string, content: string) {
    const projectDir = join(tmp, name);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name,
        bundleSource: 'built-in:narrative_qwen_chain_relay',
        walkState: {
          bundleSource: '',
          bundleVersion: '',
          engineVersion: '',
          nodes: {
            [nodeKey]: { status: 'completed', outputPath: rel },
          },
          lastInvalidatedIds: [],
        },
      }),
      'utf8',
    );
    const abs = join(projectDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    return { projectDir, abs };
  }

  it('returns details.file_path + asset_type=image for a PNG node output', async () => {
    const { projectDir, abs } = projectWithAsset(
      'p1',
      'shot_image:scene_1_shot_3',
      'assets/scene_1/shot_3.png',
      'PNG-bytes',
    );
    const result = await makeShowNodeOutputTool().execute(
      's-1',
      { projectDir, nodeId: 'shot_image', itemId: 'scene_1_shot_3' },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const details = result.details as { file_path: string; asset_type: string };
    expect(details.file_path).toBe(abs);
    expect(details.asset_type).toBe('image');
  });

  it('infers asset_type=video for MP4 outputs', async () => {
    const { projectDir, abs } = projectWithAsset(
      'p2',
      'final_video',
      'assets/videos/final.mp4',
      'MP4',
    );
    const result = await makeShowNodeOutputTool().execute(
      's-2',
      { projectDir, nodeId: 'final_video' },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const details = result.details as { file_path: string; asset_type: string };
    expect(details.file_path).toBe(abs);
    expect(details.asset_type).toBe('video');
  });

  it('returns isError=true when the node is not in walkState', async () => {
    const { projectDir } = projectWithAsset('p3', 'other:x', 'foo.png', 'x');
    const result = await makeShowNodeOutputTool().execute(
      's-3',
      { projectDir, nodeId: 'missing' },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/not found/i);
  });

  it('returns isError=true when the file on disk is gone (outputPath stale)', async () => {
    const projectDir = join(tmp, 'p4');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        name: 'p4',
        bundleSource: 'x',
        walkState: {
          bundleSource: '',
          bundleVersion: '',
          engineVersion: '',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
          },
          lastInvalidatedIds: [],
        },
      }),
      'utf8',
    );
    const result = await makeShowNodeOutputTool().execute(
      's-4',
      { projectDir, nodeId: 'story' },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/does not exist/i);
  });
});

describe('dhee_show_file', () => {
  it('returns details.file_path + asset_type=image for an absolute PNG path', async () => {
    const filePath = join(tmp, 'screenshot.png');
    writeFileSync(filePath, 'png-bytes');
    const result = await makeShowFileTool().execute(
      's-1',
      { filePath },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const details = result.details as { file_path: string; asset_type: string };
    expect(details.file_path).toBe(filePath);
    expect(details.asset_type).toBe('image');
  });

  it('includes the optional caption in details when supplied', async () => {
    const filePath = join(tmp, 'ref.jpg');
    writeFileSync(filePath, 'x');
    const result = await makeShowFileTool().execute(
      's-2',
      { filePath, caption: 'reference image for shot 3' },
      undefined,
      undefined,
      ctx,
    );
    const details = result.details as { caption?: string };
    expect(details.caption).toBe('reference image for shot 3');
  });

  it('rejects relative paths', async () => {
    const result = await makeShowFileTool().execute(
      's-3',
      { filePath: 'relative/path.png' },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/absolute/i);
  });

  it('rejects nonexistent paths', async () => {
    const result = await makeShowFileTool().execute(
      's-4',
      { filePath: join(tmp, 'does-not-exist.png') },
      undefined,
      undefined,
      ctx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/does not exist/i);
  });

  it('marks asset_type=unknown for unrecognised extensions', async () => {
    const filePath = join(tmp, 'data.json');
    writeFileSync(filePath, '{}');
    const result = await makeShowFileTool().execute(
      's-5',
      { filePath },
      undefined,
      undefined,
      ctx,
    );
    const details = result.details as { asset_type: string };
    expect(details.asset_type).toBe('unknown');
  });
});
