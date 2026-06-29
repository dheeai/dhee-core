/**
 * listBundles — pure read of bundle metadata for the desktop Production
 * Slate. Drives the real function against a temp DHEE_USER_BUNDLES_DIR
 * (highest-precedence search root) so the fs scan, manifest parse,
 * titleize/firstSentence derivation, pickerEligible flag, dedup and
 * sort are all exercised without touching the shipped bundle tree.
 *
 * To keep the temp dir the SOLE source, the lower-precedence roots
 * (DHEE_APP_BUNDLES_DIR, ~/.dhee/bundles, repo src/dag/bundles) still
 * exist — but every assertion is on the ids WE wrote, and we use unique
 * ids that can't collide with shipped bundles.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listBundles } from '../../src/dag/listBundles.js';

let userDir: string;
let savedUserDir: string | undefined;

function writeBundle(id: string, manifest: Record<string, unknown>): void {
  const dir = join(userDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(manifest));
}

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), 'listbundles-'));
  savedUserDir = process.env['DHEE_USER_BUNDLES_DIR'];
  process.env['DHEE_USER_BUNDLES_DIR'] = userDir;
});
afterEach(() => {
  rmSync(userDir, { recursive: true, force: true });
  if (savedUserDir === undefined) delete process.env['DHEE_USER_BUNDLES_DIR'];
  else process.env['DHEE_USER_BUNDLES_DIR'] = savedUserDir;
});

function byId(id: string) {
  return listBundles().find((b) => b.id === id);
}

describe('listBundles', () => {
  it('reads explicit displayName + summary and marks the bundle picker-eligible', () => {
    writeBundle('uq_explicit_xyz', {
      id: 'uq_explicit_xyz',
      version: '1.2.3',
      displayName: 'My Bundle',
      summary: 'Does a thing well.',
      description: 'A longer description that should not override the explicit summary.',
      runtimeSupport: {
        modes: ['local', 'dhee_cloud'],
        providers: ['comfy'],
      },
    });
    const b = byId('uq_explicit_xyz');
    expect(b).toBeDefined();
    expect(b!.displayName).toBe('My Bundle');
    expect(b!.summary).toBe('Does a thing well.');
    expect(b!.version).toBe('1.2.3');
    expect(b!.pickerEligible).toBe(true);
    expect(b!.description).toBe(
      'A longer description that should not override the explicit summary.',
    );
    expect(b!.runtimeSupport).toEqual({
      modes: ['local', 'dhee_cloud'],
      providers: ['comfy'],
    });
  });

  it('titleizes the id for displayName when none is declared, preserving known acronyms', () => {
    writeBundle('uq_narrative_ltx_relay_zzz', {
      id: 'uq_narrative_ltx_relay_zzz',
      version: '0.1.0',
      description: 'whatever',
    });
    const b = byId('uq_narrative_ltx_relay_zzz');
    expect(b).toBeDefined();
    // 'ltx' is in the acronym set → uppercased; the rest title-cased.
    expect(b!.displayName).toBe('Uq Narrative LTX Relay Zzz');
  });

  it('derives summary from the first sentence of description when summary is absent', () => {
    writeBundle('uq_firstsentence_zzz', {
      id: 'uq_firstsentence_zzz',
      version: '0.1.0',
      description: 'First sentence here. Second sentence ignored.',
    });
    const b = byId('uq_firstsentence_zzz');
    expect(b!.summary).toBe('First sentence here.');
  });

  it('truncates a long first sentence to 117 chars + "..."', () => {
    const longSentence = `${'x'.repeat(200)}.`;
    writeBundle('uq_longsentence_zzz', {
      id: 'uq_longsentence_zzz',
      version: '0.1.0',
      description: longSentence,
    });
    const b = byId('uq_longsentence_zzz');
    expect(b!.summary.length).toBe(120);
    expect(b!.summary.endsWith('...')).toBe(true);
    expect(b!.summary.slice(0, 117)).toBe('x'.repeat(117));
  });

  it('is NOT picker-eligible when only displayName is declared (summary auto-derived)', () => {
    writeBundle('uq_onlyname_zzz', {
      id: 'uq_onlyname_zzz',
      version: '0.1.0',
      displayName: 'Only Name',
      description: 'derived summary.',
    });
    const b = byId('uq_onlyname_zzz');
    expect(b!.pickerEligible).toBe(false);
    expect(b!.displayName).toBe('Only Name');
  });

  it('is NOT picker-eligible when only summary is declared (displayName auto-derived)', () => {
    writeBundle('uq_onlysummary_zzz', {
      id: 'uq_onlysummary_zzz',
      version: '0.1.0',
      summary: 'A declared summary.',
    });
    const b = byId('uq_onlysummary_zzz');
    expect(b!.pickerEligible).toBe(false);
    expect(b!.summary).toBe('A declared summary.');
  });

  it('treats whitespace-only displayName/summary as not declared', () => {
    writeBundle('uq_whitespace_zzz', {
      id: 'uq_whitespace_zzz',
      version: '0.1.0',
      displayName: '   ',
      summary: '\t\n',
      description: 'fallback sentence.',
    });
    const b = byId('uq_whitespace_zzz');
    expect(b!.pickerEligible).toBe(false);
    expect(b!.displayName).toBe('Uq Whitespace Zzz');
    expect(b!.summary).toBe('fallback sentence.');
  });

  it('skips a manifest missing id', () => {
    const dir = join(userDir, 'uq_noid');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify({ version: '0.1.0' }));
    expect(listBundles().some((b) => b.displayName === 'Uq Noid')).toBe(false);
  });

  it('skips a manifest missing version', () => {
    const dir = join(userDir, 'uq_nover_zzz');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify({ id: 'uq_nover_zzz' }));
    expect(byId('uq_nover_zzz')).toBeUndefined();
  });

  it('skips a malformed (unparseable) manifest without throwing', () => {
    const dir = join(userDir, 'uq_malformed_zzz');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bundle.json'), '{ not valid json ');
    expect(() => listBundles()).not.toThrow();
    expect(byId('uq_malformed_zzz')).toBeUndefined();
  });

  it('skips a directory that has no bundle.json', () => {
    mkdirSync(join(userDir, 'uq_nomanifest_zzz'), { recursive: true });
    expect(byId('uq_nomanifest_zzz')).toBeUndefined();
  });

  it('returns results sorted by id', () => {
    writeBundle('uq_zsort_c', { id: 'uq_zsort_c', version: '0.1.0' });
    writeBundle('uq_zsort_a', { id: 'uq_zsort_a', version: '0.1.0' });
    writeBundle('uq_zsort_b', { id: 'uq_zsort_b', version: '0.1.0' });
    const ours = listBundles().filter((b) => b.id.startsWith('uq_zsort_')).map((b) => b.id);
    expect(ours).toEqual(['uq_zsort_a', 'uq_zsort_b', 'uq_zsort_c']);
  });

  it('carries techLine and inputs through when present', () => {
    writeBundle('uq_extras_zzz', {
      id: 'uq_extras_zzz',
      version: '0.1.0',
      displayName: 'Extras',
      summary: 'has extras.',
      techLine: 'LTX + Qwen',
      inputs: [{ id: 'story', type: 'text', label: 'Story' }],
    });
    const b = byId('uq_extras_zzz');
    expect(b!.techLine).toBe('LTX + Qwen');
    expect(b!.inputs).toEqual([{ id: 'story', type: 'text', label: 'Story' }]);
  });

  it('infers runtimeSupport from runner tools when metadata is absent', () => {
    writeBundle('uq_runtime_fallback_zzz', {
      id: 'uq_runtime_fallback_zzz',
      version: '0.1.0',
      nodes: [
        { id: 'text', runner: { tool: 'llm.generate' } },
        { id: 'clip', runner: { tool: 'ffmpeg.concat' } },
      ],
    });
    const b = byId('uq_runtime_fallback_zzz');
    expect(b!.runtimeSupport).toEqual({
      modes: ['local', 'dhee_cloud'],
      providers: ['llm', 'ffmpeg'],
    });
  });

  it('first-seen-wins: a top-level .json manifest file is also scanned', () => {
    // A bare <id>.json file (not a dir) is a valid manifest per the scan.
    writeFileSync(
      join(userDir, 'uq_filemanifest_zzz.json'),
      JSON.stringify({ id: 'uq_filemanifest_zzz', version: '0.9.0', displayName: 'File Manifest', summary: 'from a file.' }),
    );
    const b = byId('uq_filemanifest_zzz');
    expect(b).toBeDefined();
    expect(b!.version).toBe('0.9.0');
    expect(b!.pickerEligible).toBe(true);
  });
});
