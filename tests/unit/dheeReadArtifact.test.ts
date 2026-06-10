/**
 * dhee_read_artifact — read a node's produced artifact.
 *
 * Zero prior direct coverage. The tool resolves an outputPath from
 * project.json's walkState and returns text inline (md/json/txt/srt…)
 * or a path+size line for binary/oversized files. We cover every
 * branch: missing project.json, malformed json, unknown node, no
 * outputPath, file-deleted, text inline, oversize text, binary, and
 * relative-path resolution against the project dir.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeReadArtifactTool } from '../../src/agent/pi/tools/dheeReadArtifact.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => existsSync(d) && rmSync(d, { recursive: true, force: true }));
});

function tmpProject(walkStateNodes: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'read-artifact-'));
  made.push(dir);
  if (walkStateNodes !== null) {
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({ name: 'x', walkState: { nodes: walkStateNodes } }),
    );
  }
  return dir;
}

const tool = () => makeReadArtifactTool() as unknown as ToolLike;

describe('dhee_read_artifact', () => {
  it('errors when project.json is missing', async () => {
    const dir = tmpProject(null);
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/project\.json not found/i);
  });

  it('errors when project.json is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-artifact-bad-'));
    made.push(dir);
    writeFileSync(join(dir, 'project.json'), '{ not valid json');
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/failed to parse/i);
  });

  it('errors when the node is not in walkState', async () => {
    const dir = tmpProject({});
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/not found in walkState/i);
  });

  it('errors when the node has no outputPath', async () => {
    const dir = tmpProject({ story: { status: 'in_progress' } });
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/no outputPath/i);
  });

  it('errors when the outputPath no longer exists on disk', async () => {
    const dir = tmpProject({ story: { status: 'completed', outputPath: 'plans/story.md' } });
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/does not exist on disk/i);
  });

  it('returns text content inline for a small markdown artifact', async () => {
    const dir = tmpProject({ story: { status: 'completed', outputPath: 'plans/story.md' } });
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans/story.md'), '# Once upon a time');
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toContain('# Once upon a time');
  });

  it('does not inline an oversized text file (returns path + size only)', async () => {
    const dir = tmpProject({ story: { status: 'completed', outputPath: 'plans/big.md' } });
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'plans/big.md'), 'x'.repeat(70 * 1024)); // > 64 KiB limit
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/too large to inline/i);
    expect(out.content[0].text).not.toContain('xxxxxxxxxx');
  });

  it('returns path + size for a binary artifact (does not inline bytes)', async () => {
    const dir = tmpProject({ shot: { status: 'completed', outputPath: 'assets/shot.png' } });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const out = await tool().execute('t', { projectDir: dir, nodeId: 'shot' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/binary; not inlined/i);
  });

  it('resolves a collection item via nodeId:itemId key', async () => {
    const dir = tmpProject({
      'shot_image:scene_1_shot_3': {
        status: 'completed',
        outputPath: 'assets/3.png',
        itemId: 'scene_1_shot_3',
      },
    });
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/3.png'), Buffer.from([0x89]));
    const out = await tool().execute('t', {
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
    });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/binary; not inlined/i);
  });
});
