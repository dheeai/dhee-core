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

describe('OpenRouter documentary built-in runner registration', () => {
  it('registers OpenRouter image and video runners in the global registry', () => {
    const reg = getGlobalRegistry();

    expect(reg.get('openrouter.image')?.describe().id).toBe('openrouter.image');
    expect(reg.get('openrouter.video')?.describe().id).toBe('openrouter.video');
  });

  it('validates the OpenRouter documentary bundle when OpenRouter credentials are present', () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf-8')) as DagBundle;

      expect(getGlobalRegistry().validateBundle(bundle)).toEqual({ ok: true });
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousKey;
      }
    }
  });
});
