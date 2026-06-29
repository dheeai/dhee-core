/**
 * userBundlesDir — env-precedence resolver for where community/user
 * bundles install. The only exported installBundle helper not already
 * covered by installBundle.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { userBundlesDir } from '../../src/dag/installBundle.js';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env['DHEE_USER_BUNDLES_DIR'];
});
afterEach(() => {
  if (saved === undefined) delete process.env['DHEE_USER_BUNDLES_DIR'];
  else process.env['DHEE_USER_BUNDLES_DIR'] = saved;
});

describe('userBundlesDir', () => {
  it('returns DHEE_USER_BUNDLES_DIR when set', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = '/tmp/custom/bundles';
    expect(userBundlesDir()).toBe('/tmp/custom/bundles');
  });

  it('falls back to ~/.dhee/bundles when the env var is unset', () => {
    delete process.env['DHEE_USER_BUNDLES_DIR'];
    expect(userBundlesDir()).toBe(resolve(homedir(), '.dhee/bundles'));
  });

  it('falls back when the env var is empty / whitespace-only', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = '   ';
    expect(userBundlesDir()).toBe(resolve(homedir(), '.dhee/bundles'));
  });

  it('trims the configured value', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = '  /tmp/trimmed  ';
    expect(userBundlesDir()).toBe('/tmp/trimmed');
  });
});
