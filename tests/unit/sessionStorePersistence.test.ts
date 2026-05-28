/**
 * sessionStore round-trip tests.
 *
 * Exercises the persistence layer end-to-end without booting a real
 * pi-coding-agent (which would need an LLM, auth, etc):
 *  - sessionStore: record / find / mostRecent / forget / purge
 *
 * Avoids the project rule against grep-based tests by exercising actual
 * behavior: writing real files, reading them back, asserting on
 * structured outputs.
 *
 * historyReplay-based tests (the old buildHistoryFromFile suite) were
 * removed in d6f11bd along with the legacy executor; if the desktop's
 * chat-resume layer comes back it will get its own test file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../src/agent/pi/sessionStore.js';

const ENV_KEY = 'DHEE_PI_SESSIONS_DIR';
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'kshana-session-store-'));
  process.env[ENV_KEY] = tempRoot;
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe('sessionStore', () => {
  it('records and finds a session, persisting projectSlug + path', async () => {

    const slug = 'demo';
    const file = store.sessionFilePathFor('s-1', slug);
    // Pretend the JSONL exists (writing a stub is enough — findSession
    // checks existsSync).
    store.ensureProjectSessionsDir(slug);
    writeFileSync(file, '', 'utf8');

    const rec = store.recordSession('s-1', slug, file);
    expect(rec.sessionId).toBe('s-1');
    expect(rec.projectSlug).toBe(slug);
    expect(rec.sessionFile).toBe(file);

    const found = store.findSession('s-1');
    expect(found).not.toBeNull();
    expect(found!.sessionFile).toBe(file);
  });

  it('returns the most recent session for a project', async () => {

    store.ensureProjectSessionsDir('p1');
    store.ensureProjectSessionsDir('p2');
    const f1 = store.sessionFilePathFor('a', 'p1');
    const f2 = store.sessionFilePathFor('b', 'p1');
    const f3 = store.sessionFilePathFor('c', 'p2');
    for (const f of [f1, f2, f3]) writeFileSync(f, '', 'utf8');

    store.recordSession('a', 'p1', f1);
    await new Promise(r => setTimeout(r, 5));
    store.recordSession('b', 'p1', f2);
    await new Promise(r => setTimeout(r, 5));
    store.recordSession('c', 'p2', f3);

    const recent = store.mostRecentForProject('p1');
    expect(recent?.sessionId).toBe('b');

    const recentP2 = store.mostRecentForProject('p2');
    expect(recentP2?.sessionId).toBe('c');
  });

  it('reflects setSessionProject in subsequent project queries', async () => {

    store.ensureProjectSessionsDir(store.AMBIENT_PROJECT_SLUG);
    const file = store.sessionFilePathFor('s-amb', store.AMBIENT_PROJECT_SLUG);
    writeFileSync(file, '', 'utf8');
    store.recordSession('s-amb', store.AMBIENT_PROJECT_SLUG, file);

    expect(store.mostRecentForProject('chosen')).toBeNull();
    store.setSessionProject('s-amb', 'chosen');
    const recent = store.mostRecentForProject('chosen');
    expect(recent?.sessionId).toBe('s-amb');
  });

  it('forgetSession drops the index entry but keeps the file', async () => {

    store.ensureProjectSessionsDir('p');
    const file = store.sessionFilePathFor('keep', 'p');
    writeFileSync(file, 'data', 'utf8');
    store.recordSession('keep', 'p', file);

    store.forgetSession('keep');
    expect(store.findSession('keep')).toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it('purgeSessionHistory removes both index entry and JSONL', async () => {

    store.ensureProjectSessionsDir('p');
    const file = store.sessionFilePathFor('blast', 'p');
    writeFileSync(file, 'data', 'utf8');
    store.recordSession('blast', 'p', file);

    store.purgeSessionHistory('blast');
    expect(store.findSession('blast')).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('findSession returns null when the JSONL has been deleted out from under us', async () => {

    store.ensureProjectSessionsDir('p');
    const file = store.sessionFilePathFor('orphan', 'p');
    writeFileSync(file, '', 'utf8');
    store.recordSession('orphan', 'p', file);

    rmSync(file);
    expect(store.findSession('orphan')).toBeNull();
  });

  it('mostRecentSession returns the most recently-touched record across all projects', async () => {

    store.ensureProjectSessionsDir('p1');
    store.ensureProjectSessionsDir('p2');
    const a = store.sessionFilePathFor('aa', 'p1');
    const b = store.sessionFilePathFor('bb', 'p2');
    writeFileSync(a, '', 'utf8');
    writeFileSync(b, '', 'utf8');

    store.recordSession('aa', 'p1', a);
    await new Promise(r => setTimeout(r, 5));
    store.recordSession('bb', 'p2', b);

    const recent = store.mostRecentSession();
    expect(recent?.sessionId).toBe('bb');
  });

  it('listSessionsForProject returns sessions ordered by lastActivity desc, only for that project', async () => {

    store.ensureProjectSessionsDir('p1');
    store.ensureProjectSessionsDir('p2');
    const f1 = store.sessionFilePathFor('s1', 'p1');
    const f2 = store.sessionFilePathFor('s2', 'p1');
    const f3 = store.sessionFilePathFor('s3', 'p2');
    for (const f of [f1, f2, f3]) writeFileSync(f, '', 'utf8');

    store.recordSession('s1', 'p1', f1);
    await new Promise(r => setTimeout(r, 5));
    store.recordSession('s2', 'p1', f2);
    store.recordSession('s3', 'p2', f3);

    const p1 = store.listSessionsForProject('p1');
    expect(p1.map(r => r.sessionId)).toEqual(['s2', 's1']);
    const p2 = store.listSessionsForProject('p2');
    expect(p2.map(r => r.sessionId)).toEqual(['s3']);
  });
});
