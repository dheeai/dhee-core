import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listBundles } from '../../src/dag/listBundles.js';

function setupUserBundle(id: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dhee-user-bundles-'));
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, id, 'bundle.json'),
    JSON.stringify({
      id,
      version: '0.1.0',
      displayName: 'YouTube Short',
      summary: 'Short-form vertical video.',
      goal: 'final_video',
      nodes: [
        {
          id: 'final_video',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'video', pattern: 'final/out.mp4' },
          runner: { tool: 'ffmpeg.concat', config: {} },
        },
      ],
    })
  );
  return root;
}

describe('listBundles source metadata', () => {
  const made: string[] = [];
  const prevUser = process.env['DHEE_USER_BUNDLES_DIR'];

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (prevUser === undefined) delete process.env['DHEE_USER_BUNDLES_DIR'];
    else process.env['DHEE_USER_BUNDLES_DIR'] = prevUser;
  });

  it('marks bundles from DHEE_USER_BUNDLES_DIR as user bundle sources', () => {
    const root = setupUserBundle('youtube_short_text_video');
    made.push(root);
    process.env['DHEE_USER_BUNDLES_DIR'] = root;

    const found = listBundles().find(bundle => bundle.id === 'youtube_short_text_video');

    expect(found).toMatchObject({
      id: 'youtube_short_text_video',
      bundleSource: 'user:youtube_short_text_video',
      sourceScheme: 'user',
      pickerEligible: true,
    });
  });
});
