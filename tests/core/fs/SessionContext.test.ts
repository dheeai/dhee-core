/**
 * Tests for SessionContext — verifies per-session isolation via AsyncLocalStorage.
 */
import { describe, it, expect } from 'vitest';
import {
  runInSession,
  createLocalSession,
  getSessionProjectDir,
  setSessionProjectDir,
  getSessionFs,
  getCurrentSession,
  setDefaultProjectDir,
} from '../../../src/core/fs/SessionContext.js';
import { LocalFileSystem } from '../../../src/core/fs/LocalFileSystem.js';

describe('SessionContext', () => {
  it('returns default project dir outside a session', () => {
    setDefaultProjectDir('fallback.dhee');
    expect(getSessionProjectDir()).toBe('fallback.dhee');
  });

  it('returns session project dir inside a session', () => {
    const session = createLocalSession('test-1', 'project-a.dhee');

    runInSession(session, () => {
      expect(getSessionProjectDir()).toBe('project-a.dhee');
    });
  });

  it('isolates two concurrent sessions', async () => {
    const sessionA = createLocalSession('sess-a', 'alpha.dhee');
    const sessionB = createLocalSession('sess-b', 'beta.dhee');

    const results: string[] = [];

    const promiseA = runInSession(sessionA, async () => {
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      results.push(`A:${getSessionProjectDir()}`);
    });

    const promiseB = runInSession(sessionB, async () => {
      await new Promise((r) => setTimeout(r, 5));
      results.push(`B:${getSessionProjectDir()}`);
    });

    await Promise.all([promiseA, promiseB]);

    expect(results).toContain('A:alpha.dhee');
    expect(results).toContain('B:beta.dhee');
  });

  it('setSessionProjectDir mutates only the current session', () => {
    const sessionA = createLocalSession('sess-a', 'original.dhee');

    runInSession(sessionA, () => {
      setSessionProjectDir('changed.dhee');
      expect(getSessionProjectDir()).toBe('changed.dhee');
    });

    // Outside session, default is unaffected
    setDefaultProjectDir('default.dhee');
    expect(getSessionProjectDir()).toBe('default.dhee');
  });

  it('provides LocalFileSystem via getSessionFs()', () => {
    const session = createLocalSession('test-fs');
    runInSession(session, () => {
      const fs = getSessionFs();
      expect(fs).toBeInstanceOf(LocalFileSystem);
    });
  });

  it('getCurrentSession returns undefined outside session', () => {
    expect(getCurrentSession()).toBeUndefined();
  });

  it('getCurrentSession returns context inside session', () => {
    const session = createLocalSession('test-ctx', 'ctx.dhee');
    runInSession(session, () => {
      const ctx = getCurrentSession();
      expect(ctx).toBeDefined();
      expect(ctx!.sessionId).toBe('test-ctx');
      expect(ctx!.projectDir).toBe('ctx.dhee');
      expect(ctx!.mode).toBe('local');
    });
  });
});
