/**
 * ffmpeg.concat subtitle drawtext — regression for the live failure where
 * a subtitle line `the_diver: I'm not alone.` broke the re-encode pass:
 *   - "No font filename provided" (no fontfile on the static ffmpeg build)
 *   - the `'` inside `text='...'` truncated the filter (`enable=between(t`)
 * Fix: resolve a real font + pass cue text via `textfile=` (no inline escaping).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSubtitleFont, buildDrawtextChain } from '../../src/dag/runners/ffmpegConcat.js';

describe('resolveSubtitleFont', () => {
  let savedEnv: string | undefined;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['DHEE_SUBTITLE_FONT'];
    else process.env['DHEE_SUBTITLE_FONT'] = savedEnv;
  });

  it('honors DHEE_SUBTITLE_FONT when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'font-'));
    const font = join(dir, 'fake.ttf');
    writeFileSync(font, 'x');
    savedEnv = process.env['DHEE_SUBTITLE_FONT'];
    process.env['DHEE_SUBTITLE_FONT'] = font;
    try {
      expect(resolveSubtitleFont()).toBe(font);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores DHEE_SUBTITLE_FONT pointing at a missing file', () => {
    savedEnv = process.env['DHEE_SUBTITLE_FONT'];
    process.env['DHEE_SUBTITLE_FONT'] = '/no/such/font.ttf';
    // Returns either a real system font or null — never the bogus path.
    expect(resolveSubtitleFont()).not.toBe('/no/such/font.ttf');
  });
});

describe('buildDrawtextChain', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'subs-'));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('passes cue text via textfile (not inline), surviving colons/quotes/commas/parens', () => {
    const nasty = "the_diver: I'm not alone, (whisper) — 50% sure";
    const chain = buildDrawtextChain(
      [{ start: 1.5, end: 4.25, text: nasty }],
      '0:v',
      'withsubs',
      '/fonts/Arial.ttf',
      tmpDir,
    );
    // Uses textfile + fontfile, NOT inline text='...'.
    expect(chain).toContain('fontfile=\'/fonts/Arial.ttf\'');
    expect(chain).toContain('textfile=');
    expect(chain).not.toContain("text='the_diver");
    expect(chain).toContain("enable='between(t,1.500,4.250)'");
    // The cue file holds the RAW text — no escaping, so special chars are safe.
    const cueFile = join(tmpDir, readdirSync(tmpDir).find((f) => f.startsWith('cue_'))!);
    expect(readFileSync(cueFile, 'utf-8')).toBe(nasty);
  });

  it('chains multiple cues comma-separated into one labeled segment', () => {
    const chain = buildDrawtextChain(
      [
        { start: 0, end: 1, text: 'a' },
        { start: 1, end: 2, text: 'b' },
      ],
      '0:v',
      'withsubs',
      '/f.ttf',
      tmpDir,
    );
    expect(chain.startsWith('[0:v]')).toBe(true);
    expect(chain.endsWith('[withsubs]')).toBe(true);
    expect(chain.split('drawtext=').length - 1).toBe(2);
  });
});
