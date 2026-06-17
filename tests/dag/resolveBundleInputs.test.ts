/**
 * resolveBundleInputs — file-input resolution.
 *
 * Binary assets (images / audio / video) must resolve to their ABSOLUTE PATH
 * so a runner can upload or animate the file; text files resolve to their
 * CONTENT (prompt templates / TTS read the text), and .json to parsed JSON.
 *
 * Before this, every file input was read as UTF-8 text — so a UGC bundle's
 * creator photo / reference voice / clip came back as garbled bytes instead
 * of a path the comfy runners could use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { resolveBundleInputs } from '../../src/dag/walker.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resolve-inputs-'));
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 't' }), 'utf8');
  writeFileSync(join(dir, 'story.md'), 'Once upon a time.', 'utf8');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ a: 1 }), 'utf8');
  // pretend-binary assets (content is irrelevant — only the path matters)
  for (const f of ['creator.png', 'voice.wav', 'clip.mp4']) {
    writeFileSync(join(dir, f), Buffer.from([0x00, 0x01, 0x02]));
  }
});

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveBundleInputs file resolution', () => {
  it('resolves image/audio/video files to an existing ABSOLUTE path, not their bytes', () => {
    const out = resolveBundleInputs(
      [
        { id: 'creator', kind: 'file', path: 'creator.png' },
        { id: 'voice', kind: 'file', path: 'voice.wav' },
        { id: 'clip', kind: 'file', path: 'clip.mp4' },
      ] as never,
      dir,
    );
    for (const key of ['creator', 'voice', 'clip']) {
      const v = out[key];
      expect(typeof v).toBe('string');
      expect(isAbsolute(v as string)).toBe(true);
      expect(existsSync(v as string)).toBe(true);
    }
    // counter: it must NOT have read the file bytes as content
    expect(out['creator']).toBe(join(dir, 'creator.png'));
  });

  it('resolves text files to their CONTENT and .json to parsed JSON', () => {
    const out = resolveBundleInputs(
      [
        { id: 'story', kind: 'file', path: 'story.md' },
        { id: 'plan', kind: 'file', path: 'plan.json' },
      ] as never,
      dir,
    );
    expect(out['story']).toBe('Once upon a time.');
    expect(out['plan']).toEqual({ a: 1 });
  });

  it('uppercase / mixed-case binary extensions still resolve to a path', () => {
    writeFileSync(join(dir, 'HERO.JPG'), Buffer.from([0xff, 0xd8]));
    const out = resolveBundleInputs(
      [{ id: 'hero', kind: 'file', path: 'HERO.JPG' }] as never,
      dir,
    );
    expect(out['hero']).toBe(join(dir, 'HERO.JPG'));
  });

  it('throws on a missing required file input', () => {
    expect(() =>
      resolveBundleInputs([{ id: 'missing', kind: 'file', path: 'nope.png' }] as never, dir),
    ).toThrow();
  });

  it('skips a missing OPTIONAL file input without throwing', () => {
    const out = resolveBundleInputs(
      [{ id: 'opt', kind: 'file', path: 'nope.wav', required: false }] as never,
      dir,
    );
    expect(out['opt']).toBeUndefined();
  });
});
