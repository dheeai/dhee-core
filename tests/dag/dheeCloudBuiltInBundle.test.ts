import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getGlobalRegistry } from '../../src/dag/runners/registry.js';
import '../../src/dag/runners/index.js';
import type { DagBundle } from '../../src/dag/schema.js';

const BUNDLE_PATH = resolve(
  __dirname,
  '../../bundles/openrouter_youtube_documentary/bundle.json',
);

describe('Dhee Cloud documentary built-in runner registration', () => {
  it('registers Dhee Cloud image and video runners in the global registry', () => {
    const reg = getGlobalRegistry();

    expect(reg.get('dhee.cloud.image')?.describe().id).toBe('dhee.cloud.image');
    expect(reg.get('dhee.cloud.video')?.describe().id).toBe('dhee.cloud.video');
    expect(reg.get('openrouter.image')).toBeUndefined();
    expect(reg.get('openrouter.video')).toBeUndefined();
  });

  it('validates the Dhee Cloud documentary bundle when desktop cloud credentials are present', () => {
    const previousUrl = process.env.DHEE_CLOUD_URL;
    const previousToken = process.env.DHEE_CLOUD_TOKEN;
    process.env.DHEE_CLOUD_URL = 'https://cloud.dhee.test';
    process.env.DHEE_CLOUD_TOKEN = 'desktop-token';
    try {
      const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf-8')) as DagBundle;

      expect(bundle.dependencies?.runners).toMatchObject({
        'dhee.cloud.image': '>=0.1.0',
        'dhee.cloud.video': '>=0.1.0',
      });
      expect(getGlobalRegistry().validateBundle(bundle)).toEqual({ ok: true });
    } finally {
      if (previousUrl === undefined) {
        delete process.env.DHEE_CLOUD_URL;
      } else {
        process.env.DHEE_CLOUD_URL = previousUrl;
      }
      if (previousToken === undefined) {
        delete process.env.DHEE_CLOUD_TOKEN;
      } else {
        process.env.DHEE_CLOUD_TOKEN = previousToken;
      }
    }
  });
});
