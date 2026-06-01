/**
 * dhee_read / dhee_ls / dhee_grep / dhee_find — TDD coverage.
 *
 * Focus: the scope guard refuses paths outside projectDir for each
 * tool. Functional behavior (reading bytes, listing entries, matching
 * patterns) is light-touched — the scope guard is the architectural
 * win these tools deliver.
 *
 * Failure modes:
 *   dhee_read:
 *     1. path inside project → returns content.
 *     2. path outside project → refused (isError, mentions "outside").
 *     3. relative path → refused (absolute required).
 *     4. missing file → error (clean message).
 *
 *   dhee_ls:
 *     5. path inside project → lists entries.
 *     6. path outside project → refused.
 *     7. file (not dir) → error.
 *
 *   dhee_grep:
 *     8. pattern matching a file inside project → returns hits.
 *     9. start path outside project → refused.
 *    10. default start = projectDir works.
 *    11. skips binary files (no png contents in result).
 *
 *   dhee_find:
 *    12. glob pattern matches files inside project.
 *    13. start path outside project → refused.
 *    14. ** glob crosses directory boundaries.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeReadTool,
  makeLsTool,
  makeGrepTool,
  makeFindTool,
} from '../../src/agent/pi/tools/dheeFs.js';

interface ToolLike<P> {
  execute: (id: string, params: P) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

describe('dhee_fs tools', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'dhee-fs-test-'));
    dirs.push(root);
    mkdirSync(join(root, 'inputs'), { recursive: true });
    mkdirSync(join(root, 'assets/images'), { recursive: true });
    writeFileSync(join(root, 'inputs/story.md'), '# the story\n\nA hero rises.');
    writeFileSync(join(root, 'project.json'), '{"name":"X"}');
    writeFileSync(join(root, 'assets/images/lara.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return root;
  }

  describe('dhee_read', () => {
    const tool = makeReadTool() as unknown as ToolLike<{ projectDir: string; path: string; maxBytes?: number }>;

    it('1. path inside project → returns content', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, path: join(p, 'inputs/story.md') });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('A hero rises');
    });

    it('2. path outside project → refused', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, path: '/etc/hosts' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/outside|scope|project/i);
    });

    it('3. relative path → refused (absolute required)', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, path: 'inputs/story.md' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/absolute/i);
    });

    it('4. missing file → clean error', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, path: join(p, 'no_such.md') });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/not found/i);
    });
  });

  describe('dhee_ls', () => {
    const tool = makeLsTool() as unknown as ToolLike<{ projectDir: string; path: string }>;

    it('5. path inside project → lists entries', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, path: join(p, 'inputs') });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('story.md');
    });

    it('6. path outside project → refused', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, path: '/tmp' });
      expect(r.isError).toBe(true);
    });
  });

  describe('dhee_grep', () => {
    const tool = makeGrepTool() as unknown as ToolLike<{ projectDir: string; pattern: string; path?: string; caseInsensitive?: boolean; maxMatches?: number }>;

    it('8. pattern matching a file inside project → returns hits', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, pattern: 'hero' });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toMatch(/inputs\/story\.md:\d+:.*hero/);
    });

    it('9. start path outside project → refused', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, pattern: 'anything', path: '/etc' });
      expect(r.isError).toBe(true);
    });

    it('10. default start = projectDir works', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, pattern: 'story' });
      expect(r.isError).toBeFalsy();
    });

    it('11. skips binary files', async () => {
      const p = project();
      // PNG header bytes shouldn't appear as a grep hit even if regex matches some byte.
      const r = await tool.execute('t', { projectDir: p, pattern: 'PNG' });
      expect(r.isError).toBeFalsy();
      // Either no matches OR matches only in text files — but the .png should NOT appear.
      expect(r.content[0].text).not.toMatch(/lara\.png/);
    });
  });

  describe('dhee_find', () => {
    const tool = makeFindTool() as unknown as ToolLike<{ projectDir: string; pattern: string; path?: string; maxResults?: number }>;

    it('12. glob matches files inside project', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, pattern: '**/*.md' });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('inputs/story.md');
    });

    it('13. start path outside project → refused', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, pattern: '*.md', path: '/etc' });
      expect(r.isError).toBe(true);
    });

    it('14. ** glob crosses directory boundaries', async () => {
      const p = project();
      const r = await tool.execute('t', { projectDir: p, pattern: '**/*.png' });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('assets/images/lara.png');
    });
  });
});
